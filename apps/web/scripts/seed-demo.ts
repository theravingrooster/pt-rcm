import { readFile } from "node:fs/promises";
import { FixtureClearinghouse, parseSynthetic835, renderFixture835 } from "@pt-rcm/clearinghouse";
import { ClaimDocumentSchema, EncounterIngestSchema } from "@pt-rcm/domain";
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

async function lockShoulderNote() {
  const endpoint = new URL("/api/charts/lock", process.env.ENCOUNTER_API_URL ?? "http://localhost:3000");
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      externalNoteId: "SYN-LOCKED-SHOULDER-NOTE",
      patientExternalId: "SYN-PATIENT-SHOULDER",
      renderingNpi: "0000000003",
      dateOfService: "2026-10-01",
      diagnoses: ["M25.511"],
      timedEntries: [
        { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" },
        { cptCode: "97530", startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z" },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Demo chart lock failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<{ encounterId: string }>;
}

async function syntheticEncounter(externalId: string, patientExternalId: string, patientName: string) {
  const fixture = JSON.parse(await readFile(new URL("../../../fixtures/encounters/underbilled-40min.json", import.meta.url), "utf8"));
  fixture.externalId = externalId;
  fixture.patient.externalId = patientExternalId;
  fixture.patient.name.lastName = patientName;
  fixture.patient.coverage.memberId = `SYN-MEMBER-${patientExternalId}`;
  return EncounterIngestSchema.parse(fixture);
}

const connection = createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
try {
  const organizationId = process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID;
  const [shoulder] = await connection.client`select id from encounters
    where organization_id = ${organizationId} and external_id = 'SYN-SHOULDER-23MIN'`;
  console.log(shoulder ? "Synthetic shoulder encounter already present:"
    : "Synthetic shoulder encounter ingested:", shoulder
      ? { encounterId: shoulder.id } : await ingest("shoulder-23min"));
  const [lockedNote] = await connection.client`select id from encounters
    where organization_id = ${organizationId} and external_id = 'SYN-CHART-SYN-LOCKED-SHOULDER-NOTE'`;
  console.log(lockedNote ? "Synthetic locked shoulder note already present:"
    : "Synthetic locked shoulder note ingested:", lockedNote
      ? { encounterId: lockedNote.id } : await lockShoulderNote());
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
          const text = renderFixture835({ claimId, claimVersion: Number(saved.version),
            totalChargeCents: document.totalChargeCents, receivedOn: new Date().toISOString().slice(0, 10),
            outcome: "DENIED", lines: document.lines.map((line) => ({ cptCode: line.cptCode,
              units: line.units, chargeCents: line.chargeCents })),
          });
          // The synthetic denial is parsed from the same text format as fixture
          // polling. Polling excludes claims once their receipt is posted.
          status = (await postRemit(connection.db, organizationId, parseSynthetic835(text))).status;
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
