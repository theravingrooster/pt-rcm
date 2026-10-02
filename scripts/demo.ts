import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureClearinghouse } from "../packages/clearinghouse/src/index.js";
import { ClaimNotSubmittable, EncounterIngestSchema, fixtureLineChargeCents,
  loadMedicareMinuteLadder, minutesToUnits, unitsLeftOnTable } from "../packages/domain/src/index.js";
import { createDatabase, loadFixtureRemitScripts, pollRemits, readOperatorMetrics,
  scrubEncounter, submitScrubbedClaim, upsertEncounter } from "../packages/db/src/index.js";
import { seedSyntheticData } from "../packages/db/src/seed-database.js";
import { seedOrganization } from "../packages/db/src/seed-data.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const organizationId = seedOrganization.id;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const percent = (fraction: number | null) => fraction === null ? "n/a" : `${(fraction * 100).toFixed(1)}%`;

// Fail before changing data if source code contains a fetch to an external
// host. This includes any real clearinghouse host, not just one known vendor.
async function assertFixtureOnlyFetches() {
  const ignored = new Set([".git", "node_modules", ".next", "dist", "coverage", ".turbo"]);
  const source = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|ya?ml|sh)$/;
  const forbiddenHost = ["api", "stedi", "com"].join(".");
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile() || !source.test(entry.name)) continue;
      const contents = await readFile(path, "utf8");
      if (!/\bfetch\s*\(/.test(contents)) continue;
      const hosts = [...contents.matchAll(/https?:\/\/[^\s"'`<>)}\\]+/g)].map(([url]) => new URL(url).hostname);
      const external = hosts.find((host) => !["localhost", "127.0.0.1", "[::1]"].includes(host));
      if (contents.includes(forbiddenHost) || external) {
        throw new Error(`Refusing demo: fetch to a real host found in ${relative(root, path)}${external ? ` (${external})` : ""}`);
      }
    }
  };
  await walk(root);
}

// Keep shared fixture payers and immutable rule packs. Replace only this
// synthetic organization's rows, including evidence and audit history.
async function resetSyntheticOrganization(client: ReturnType<typeof createDatabase>["client"]) {
  await client.begin(async (sql) => {
    const ids = (rows: readonly { id: string }[]) => rows.map(({ id }) => id);
    const patients = ids(await sql`select id from patients where organization_id = ${organizationId}`);
    const encounters = ids(await sql`select id from encounters where organization_id = ${organizationId}`);
    const claims = encounters.length ? ids(await sql`select id from claims where encounter_id = any(${encounters}::uuid[])`) : [];
    const remits = claims.length ? ids(await sql`select id from remits where claim_id = any(${claims}::uuid[])`) : [];
    const tasks = claims.length ? ids(await sql`select id from tasks where claim_id = any(${claims}::uuid[])`) : [];
    const facilities = ids(await sql`select id from service_facilities where organization_id = ${organizationId}`);
    const providers = ids(await sql`select id from providers where organization_id = ${organizationId}`);
    const auditIds = [organizationId, ...patients, ...encounters, ...claims, ...remits, ...tasks, ...facilities, ...providers];
    await sql`delete from audit_events where entity_id = any(${auditIds}::uuid[])`;
    if (remits.length) {
      await sql`delete from remit_lines where remit_id = any(${remits}::uuid[])`;
      await sql`delete from remits where id = any(${remits}::uuid[])`;
    }
    if (claims.length) {
      await sql`delete from tasks where claim_id = any(${claims}::uuid[])`;
      await sql`delete from rule_fires where claim_id = any(${claims}::uuid[])`;
      await sql`delete from claim_lines where claim_id = any(${claims}::uuid[])`;
      await sql`delete from claims where id = any(${claims}::uuid[])`;
    }
    if (encounters.length) {
      await sql`delete from encounter_minute_lines where encounter_id = any(${encounters}::uuid[])`;
      await sql`delete from diagnoses where encounter_id = any(${encounters}::uuid[])`;
      await sql`delete from encounters where id = any(${encounters}::uuid[])`;
    }
    if (patients.length) {
      await sql`delete from plans_of_care where patient_id = any(${patients}::uuid[])`;
      await sql`delete from authorizations where patient_id = any(${patients}::uuid[])`;
      await sql`delete from coverages where patient_id = any(${patients}::uuid[])`;
      await sql`delete from patients where id = any(${patients}::uuid[])`;
    }
    await sql`delete from providers where organization_id = ${organizationId}`;
    await sql`delete from service_facilities where organization_id = ${organizationId}`;
    await sql`delete from organizations where id = ${organizationId}`;
  });
}

await assertFixtureOnlyFetches();
console.log("Safety scan passed: no repository fetch source contains an external host.");
const connection = createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
try {
  await resetSyntheticOrganization(connection.client);
  await seedSyntheticData(connection.db);
  console.log("0. Reset synthetic organization and reseeded fixture configuration.");

  const source = EncounterIngestSchema.parse(JSON.parse(await readFile(
    new URL("../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")));
  const shoulder = { ...structuredClone(source), externalId: "SYN-DEMO-SHOULDER-40MIN",
    patient: { ...structuredClone(source.patient), externalId: "SYN-DEMO-SHOULDER-PATIENT" },
    minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }] };
  assert.equal(shoulder.patient.coverage.payerCode, "MEDICARE");
  assert.ok(shoulder.planOfCare);
  assert.equal(shoulder.authorizationId, undefined);
  const first = await upsertEncounter(connection.db, organizationId, shoulder);
  console.log(`1. Ingested shoulder encounter ${first.encounterId}: 20 min 97110 + 20 min 97530, Medicare, valid POC; no authorization required.`);

  const scrubbed = await scrubEncounter(connection.db, organizationId, first.encounterId);
  assert.equal(scrubbed.status, "SCRUBBED");
  assert.equal(scrubbed.totalUnits, 3);
  assert.equal(scrubbed.totalChargeCents, 13500);
  assert.ok(scrubbed.lines.every((line) => line.units > 0 && line.modifiers.includes("GP")));
  assert.ok(scrubbed.findings.some((finding) => finding.ruleId === "gp-modifier" && finding.outcome === "DOWNGRADE"));
  const perCodeUnits = shoulder.minuteLines.reduce((sum, line) => sum + minutesToUnits(line.minutes, loadMedicareMinuteLadder()), 0);
  const hypotheticalLost = unitsLeftOnTable(shoulder.minuteLines.map((line) => ({ ...line, timed: true })));
  assert.equal(perCodeUnits, 2); assert.equal(hypotheticalLost, 1);
  const afterScrubMetrics = await readOperatorMetrics(connection.db, organizationId);
  assert.equal(afterScrubMetrics.centsLeftOnTable, 0);
  console.log(`2. Scrubbed ${scrubbed.status}: GP added by DOWNGRADE, ${scrubbed.totalUnits} units, ${money(scrubbed.totalChargeCents)}. Per-code rounding would bill ${perCodeUnits} units and leave ${money(hypotheticalLost * fixtureLineChargeCents("97110", 1))}; pooled billing saved all 3, so actual centsLeftOnTable is ${money(afterScrubMetrics.centsLeftOnTable)}.`);

  const submitFixture = new FixtureClearinghouse();
  const submitted = await submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId,
    { adapter: "fixture", clearinghouse: submitFixture });
  assert.equal(submitted.status, "SUBMITTED");
  console.log(`3. Submitted via fixture: ${submitted.status}, ICN ${submitted.icn}.`);

  const beforeAuth = await connection.client`select visits_used from authorizations where patient_id = ${first.patientId}`;
  assert.equal(beforeAuth.length, 0);
  const scripts = (await loadFixtureRemitScripts(connection.db, organizationId)).filter((script) => script.claimId === scrubbed.claimId);
  assert.equal(scripts.length, 1);
  const polled = await pollRemits(connection.db, organizationId, "1970-01-01",
    { adapter: "fixture", clearinghouse: new FixtureClearinghouse(scripts) });
  const result = polled.results.find((entry) => entry.claimId === scrubbed.claimId);
  assert.ok(result);
  assert.equal(result.status, "PATIENT_BALANCE");
  assert.equal(result.authorizationVisitDecremented, false);
  const [remit] = await connection.client`select paid_cents, patient_responsibility_cents from remits where id = ${result.remitId}`;
  assert.equal(remit?.paid_cents, 10800); assert.equal(remit?.patient_responsibility_cents, 2700);
  const afterAuth = await connection.client`select visits_used from authorizations where patient_id = ${first.patientId}`;
  assert.deepEqual(afterAuth, beforeAuth);
  console.log(`4. Polled fixture remit: ${result.status}; payer ${money(remit.paid_cents)} (80%), patient ${money(remit.patient_responsibility_cents)} (20%). Medicare has no linked auth; visits used stayed unchanged (${beforeAuth.length} records).`);

  const secondInput = { ...structuredClone(shoulder), externalId: "SYN-DEMO-OVERBILL-40MIN",
    patient: { ...structuredClone(shoulder.patient), externalId: "SYN-DEMO-OVERBILL-PATIENT" } };
  const second = await upsertEncounter(connection.db, organizationId, secondInput);
  const draft = await scrubEncounter(connection.db, organizationId, second.encounterId);
  assert.equal(draft.status, "SCRUBBED"); assert.equal(draft.totalUnits, 3);
  const [edited] = await connection.client`update claim_lines set units = 3, charge_cents = ${fixtureLineChargeCents("97110", 3)}
    where claim_id = ${draft.claimId} and cpt_code = '97110' and units = 2 returning id`;
  assert.ok(edited, "Expected a two-unit 97110 claim line for the hand-entry simulation");
  const blocked = await scrubEncounter(connection.db, organizationId, second.encounterId);
  assert.equal(blocked.status, "BLOCKED"); assert.equal(blocked.totalUnits, 4);
  assert.ok(blocked.blocks.some((finding) => finding.code === "OVERBILLED_UNITS"));
  const refusedFixture = new FixtureClearinghouse();
  await assert.rejects(() => submitScrubbedClaim(connection.db, organizationId, blocked.claimId,
    { adapter: "fixture", clearinghouse: refusedFixture }),
  (error: unknown) => error instanceof ClaimNotSubmittable && error.status === "BLOCKED");
  assert.equal(refusedFixture.calls.length, 0);
  console.log(`5. Ingested second 40-minute encounter, then simulated 4 hand-entered units against 3 allocated. Scrub ${blocked.status} (${blocked.blocks.map((finding) => finding.code).join(", ")}); fixture submission refused.`);

  const metrics = await readOperatorMetrics(connection.db, organizationId);
  assert.equal(metrics.claimCount, 2);
  assert.equal(metrics.centsLeftOnTable, 0);
  console.log(`6. Metrics: touchlessRate ${percent(metrics.touchlessRate)} (${metrics.touchlessCount}/${metrics.claimCount} claims); centsLeftOnTable ${money(metrics.centsLeftOnTable)}.`);
} finally {
  await connection.client.end();
}
