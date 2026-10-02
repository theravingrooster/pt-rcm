import { readFile } from "node:fs/promises";
import { EncounterIngestSchema } from "@pt-rcm/domain";
import { createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, scrubEncounter } from "@pt-rcm/db";

async function ingest(name: string) {
  const fixture = JSON.parse(await readFile(new URL(`../../../fixtures/encounters/${name}.json`, import.meta.url), "utf8"));
  const body = EncounterIngestSchema.parse(fixture);
  const response = await fetch(process.env.ENCOUNTER_API_URL ?? "http://localhost:3000/api/encounters", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Demo ingest failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<{ encounterId: string; patientId: string; status: string }>;
}

console.log("Synthetic shoulder encounter ingested:", await ingest("shoulder-23min"));
const connection = createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
try {
  const organizationId = process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID;
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
} finally {
  await connection.client.end();
}
