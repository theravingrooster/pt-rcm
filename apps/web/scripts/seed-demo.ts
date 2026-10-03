import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import { ClaimDocumentSchema, EncounterIngestSchema, type RemitEnvelope } from "@pt-rcm/domain";
import { createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, loadFixtureRemitScripts, pollRemits,
  postRemit, scrubEncounter, submitScrubbedClaim, upsertEncounter } from "@pt-rcm/db";

async function ingest(name: string) {
  const fixture = JSON.parse(await readFile(new URL(`../../../fixtures/encounters/${name}.json`, import.meta.url), "utf8"));
  const body = EncounterIngestSchema.parse(fixture);
  const response = await fetch(process.env.ENCOUNTER_API_URL ?? "http://localhost:3000/api/encounters", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Demo ingest failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<{ encounterId: string; patientId: string; status: string }>;
}

async function syntheticEncounter(externalId: string, patientExternalId: string, patientName: string) {
  const fixture = JSON.parse(await readFile(new URL("../../../fixtures/encounters/underbilled-40min.json", import.meta.url), "utf8"));
  fixture.externalId = externalId;
  fixture.patient.externalId = patientExternalId;
  fixture.patient.name.lastName = patientName;
  fixture.patient.coverage.memberId = `SYN-MEMBER-${patientExternalId}`;
  return EncounterIngestSchema.parse(fixture);
}

// A distinct, repeatable receipt ID prevents a resumed seed from double-posting.
function denialRemitId(claimId: string, version: number) {
  const hash = createHash("sha256").update(`SYN-DEMO-DENIAL:${claimId}:${version}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const connection = createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
try {
  const organizationId = process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID;
  const [shoulder] = await connection.client`select id from encounters
    where organization_id = ${organizationId} and external_id = 'SYN-SHOULDER-23MIN'`;
  console.log(shoulder ? "Synthetic shoulder encounter already present:"
    : "Synthetic shoulder encounter ingested:", shoulder
      ? { encounterId: shoulder.id } : await ingest("shoulder-23min"));
  const [existing] = await connection.client`select e.id as encounter_id, c.status as claim_status,
      c.total_charge_cents as charge_cents, c.id as claim_id
    from encounters e left join lateral (
      select id, status, total_charge_cents from claims where encounter_id = e.id
      order by version desc limit 1
    ) c on true where e.organization_id = ${organizationId} and e.external_id = 'SYN-UNDERBILLED-40MIN'`;
  if (existing?.claim_status === "SCRUBBED" && existing.charge_cents === 9000) {
    console.log("Synthetic underbilled encounter ready:", {
      encounterId: existing.encounter_id, claimId: existing.claim_id,
      billedUnits: 2, allocatedUnits: 3, centsLeftOnTable: 4500,
    });
  } else {
    // Re-ingesting an already scrubbed encounter replaces line IDs and creates a
    // new claim version. Reuse its source when completing an interrupted seed.
    const underbilled = existing?.claim_status === "SCRUBBED"
      ? { encounterId: String(existing.encounter_id) } : await ingest("underbilled-40min");
    let claim = await scrubEncounter(connection.db, organizationId, underbilled.encounterId);
    if (claim.status !== "SCRUBBED") throw new Error("Synthetic underbilling example must pass its blocking rules");
    if (claim.totalUnits === 3) {
      // The seed deliberately saves per-code rounding (1 + 1) on a day whose
      // pooled 40 minutes allow 3. A second scrub records UNDERBILLED_UNITS.
      const updated = await connection.client`update claim_lines set units = 1
        where claim_id = ${claim.claimId} and cpt_code = '97110' and units = 2 returning id`;
      if (updated.length !== 1) throw new Error("Expected one synthetic 97110 line with two allocated units");
      claim = await scrubEncounter(connection.db, organizationId, underbilled.encounterId);
    }
    if (claim.status !== "SCRUBBED" || claim.totalUnits !== 2
      || !claim.findings.some((finding) => "code" in finding && finding.code === "UNDERBILLED_UNITS")) {
      throw new Error("Synthetic underbilling example did not retain its flagged two-unit claim");
    }
    console.log("Synthetic underbilled encounter ready:", {
      encounterId: underbilled.encounterId, claimId: claim.claimId,
      billedUnits: claim.totalUnits, allocatedUnits: 3, centsLeftOnTable: 4500,
    });
  }

  async function ensureAdjudicatedDemo(kind: "denied" | "patient-balance") {
    const denied = kind === "denied";
    const externalId = denied ? "SYN-DENIED-DEMO-40MIN" : "SYN-PATIENT-BALANCE-DEMO-40MIN";
    const desired = denied ? "DENIED" : "PATIENT_BALANCE";
    const [existing] = await connection.client`select e.id as encounter_id, c.id as claim_id, c.status as claim_status
      from encounters e left join lateral (
        select id, status from claims where encounter_id = e.id order by version desc limit 1
      ) c on true where e.organization_id = ${organizationId} and e.external_id = ${externalId}`;
    const encounterId: string = existing
      ? String(existing.encounter_id)
      : (await upsertEncounter(connection.db, organizationId, await syntheticEncounter(
          externalId, `SYN-PATIENT-${kind.toUpperCase()}`, denied ? "Denial Demo" : "Patient Balance Demo",
        ))).encounterId;
    let claimId = existing?.claim_id ? String(existing.claim_id) : undefined;
    let status = existing?.claim_status ? String(existing.claim_status) : undefined;
    if (status !== desired) {
      if (!status || status === "DRAFT" || status === "BLOCKED") {
        const scrub = await scrubEncounter(connection.db, organizationId, encounterId);
        if (scrub.status !== "SCRUBBED" || scrub.totalUnits !== 3) {
          throw new Error(`Synthetic ${kind} example must scrub to three units without blocks`);
        }
        claimId = scrub.claimId;
        status = scrub.status;
      }
      if (status === "SCRUBBED") {
        if (!claimId) throw new Error(`Synthetic ${kind} claim is missing`);
        await submitScrubbedClaim(connection.db, organizationId, claimId,
          { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
        status = "SUBMITTED";
      }
      if (status === "SUBMITTED" || status === "ACCEPTED") {
        if (!claimId) throw new Error(`Synthetic ${kind} claim is missing`);
        if (denied) {
          const [saved] = await connection.client`select version, snapshot_json from claims where id = ${claimId}`;
          if (!saved) throw new Error("Synthetic denial claim disappeared before remit posting");
          const submission = saved?.snapshot_json?.submission;
          const document = ClaimDocumentSchema.parse(submission?.document);
          const envelope: RemitEnvelope = {
            id: denialRemitId(claimId, Number(saved.version)), claimId,
            payerIcn: `SYN-ICN-${claimId}`, receivedOn: new Date().toISOString().slice(0, 10),
            paidCents: 0, patientResponsibilityCents: 0, carc: "CO-16",
            adjustments: [{ carc: "CO-16", amountCents: document.totalChargeCents }],
            lines: document.lines.map((line) => ({ cptCode: line.cptCode, units: line.units,
              paidCents: 0, patientResponsibilityCents: 0,
              adjustments: [{ carc: "CO-16", amountCents: line.chargeCents }], rarc: null })),
          };
          // A crafted local denial is a recorded receipt. The 80/20 fixture
          // poller must not synthesize a later payment for this denied claim.
          status = (await postRemit(connection.db, organizationId, envelope)).status;
        } else {
          const script = (await loadFixtureRemitScripts(connection.db, organizationId))
            .find((candidate) => candidate.claimId === claimId);
          if (!script) throw new Error("Patient-balance example needs a fixture submission receipt");
          const result = await pollRemits(connection.db, organizationId, "1970-01-01",
            { adapter: "fixture", clearinghouse: new FixtureClearinghouse(script) });
          status = result.results[0]?.status;
        }
      }
    }
    if (status !== desired || !claimId) throw new Error(`Synthetic ${kind} example must end in ${desired}; got ${status}`);
    console.log(`Synthetic ${kind} claim ready:`, { encounterId, claimId, status });
  }

  await ensureAdjudicatedDemo("denied");
  await ensureAdjudicatedDemo("patient-balance");
} finally {
  await connection.client.end();
}
