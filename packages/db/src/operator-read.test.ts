import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, upsertEncounter, scrubEncounter, submitScrubbedClaim, loadFixtureRemitScripts, pollRemits, completeTask,
  listOperatorEncounters, getOperatorEncounter, getOperatorClaim, listOperatorTasks, readOperatorMetrics } from "./index.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization } from "./seed-data.js";
import * as s from "./schema.js";
const url = process.env.TEST_DATABASE_URL;
const organizationId = seedOrganization.id;
const example = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;
describe.skipIf(!url)("operator read models", () => {
  let connection: ReturnType<typeof createDatabase>;
  const patientIds: string[] = [];
  beforeAll(async () => { connection = createDatabase(url!); await seedSyntheticData(connection.db); });
  afterAll(async () => {
    if (!connection) return;
    try {
      if (patientIds.length) await connection.db.transaction(async (tx) => {
        const encounters = await tx.select().from(s.encounters).where(inArray(s.encounters.patientId, patientIds));
        const encounterIds = encounters.map((row) => row.id);
        const claims = await tx.select().from(s.claims).where(inArray(s.claims.encounterId, encounterIds));
        const claimIds = claims.map((row) => row.id);
        if (claimIds.length) {
          const remits = await tx.select().from(s.remits).where(inArray(s.remits.claimId, claimIds));
          const work = await tx.select().from(s.tasks).where(inArray(s.tasks.claimId, claimIds));
          await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, [...claimIds, ...remits.map((row) => row.id), ...work.map((row) => row.id)]));
          if (remits.length) await tx.delete(s.remitLines).where(inArray(s.remitLines.remitId, remits.map((row) => row.id)));
          await tx.delete(s.remits).where(inArray(s.remits.claimId, claimIds));
          await tx.delete(s.tasks).where(inArray(s.tasks.claimId, claimIds));
          await tx.delete(s.ruleFires).where(inArray(s.ruleFires.claimId, claimIds));
          await tx.delete(s.claimLines).where(inArray(s.claimLines.claimId, claimIds));
          await tx.delete(s.claims).where(inArray(s.claims.id, claimIds));
        }
        await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, encounterIds));
        await tx.delete(s.encounterMinuteLines).where(inArray(s.encounterMinuteLines.encounterId, encounterIds));
        await tx.delete(s.diagnoses).where(inArray(s.diagnoses.encounterId, encounterIds));
        await tx.delete(s.encounters).where(inArray(s.encounters.id, encounterIds));
        await tx.delete(s.plansOfCare).where(inArray(s.plansOfCare.patientId, patientIds));
        await tx.delete(s.authorizations).where(inArray(s.authorizations.patientId, patientIds));
        await tx.delete(s.coverages).where(inArray(s.coverages.patientId, patientIds));
        await tx.delete(s.patients).where(inArray(s.patients.id, patientIds));
      });
    } finally { await connection.client.end(); }
  });

  async function setup(poc = true) {
    const body = { ...structuredClone(example), externalId: `SYN-UI-${randomUUID()}`,
      patient: { ...structuredClone(example.patient), externalId: `SYN-UI-PATIENT-${randomUUID()}` },
      minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }] };
    if (!poc) delete body.planOfCare;
    const result = await upsertEncounter(connection.db, organizationId, body);
    patientIds.push(result.patientId);
    return result;
  }
  it("reads allocation preview, latest findings, GP document, ICN and posted remit lines", async () => {
    const { encounterId } = await setup();
    const db = connection.db;
    const before = (await listOperatorEncounters(db, organizationId)).find(row => row.encounter.id === encounterId)!;
    expect(before).toMatchObject({ units: 3, unitsSource: "Allocation preview", claim: null });
    const scrub = await scrubEncounter(db, organizationId, encounterId);
    await scrubEncounter(db, organizationId, encounterId);
    const encounter = (await getOperatorEncounter(db, organizationId, encounterId))!;
    expect(encounter.allocation.totalUnits).toBe(3);
    expect(encounter.findings).toHaveLength(8);
    expect(encounter.document.json).toContain('"GP"');
    expect((await listOperatorEncounters(db, organizationId)).find(row => row.encounter.id === encounterId)).toMatchObject({ units: 3, blocks: 0, unitsSource: "Claim" });
    const ack = await submitScrubbedClaim(db, organizationId, scrub.claimId, { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
    await pollRemits(db, organizationId, "1970-01-01", { adapter: "fixture", clearinghouse: new FixtureClearinghouse((await loadFixtureRemitScripts(db, organizationId)).filter(row => row.claimId === scrub.claimId)) });
    const claim = (await getOperatorClaim(db, organizationId, scrub.claimId))!;
    expect(claim.icn).toBe(ack.icn);
    expect(claim.claim.status).toBe("PATIENT_BALANCE");
    expect(claim.remitLines).toHaveLength(2);
    expect(claim.remitLines.every(row => row.remitLine.carc === "PR-2")).toBe(true);
    expect(claim.document.source).toBe("Submitted document snapshot");
    expect(claim.document.json).toBe(encounter.document.json);
    const task = (await listOperatorTasks(db, organizationId)).find(row => row.claim.id === scrub.claimId)!;
    expect(task.task.kind).toBe("PATIENT_INVOICE");
    await completeTask(db, organizationId, task.task.id);
    expect((await listOperatorTasks(db, organizationId)).some(row => row.task.id === task.task.id)).toBe(false);
  });
  it("shows blocks and enforces organization scope for every read", async () => {
    const { encounterId } = await setup(false);
    const db = connection.db;
    const scrub = await scrubEncounter(db, organizationId, encounterId);
    expect((await listOperatorEncounters(db, organizationId)).find(row => row.encounter.id === encounterId)!.blocks).toBeGreaterThan(0);
    expect((await getOperatorEncounter(db, organizationId, encounterId))!.document.json).toBeNull();
    const other = randomUUID();
    expect(await listOperatorEncounters(db, other)).toEqual([]);
    expect(await listOperatorTasks(db, other)).toEqual([]);
    expect(await getOperatorEncounter(db, other, encounterId)).toBeNull();
    expect(await getOperatorClaim(db, other, scrub.claimId)).toBeNull();
  });
  it("counts actual saved underbilling, stays stable on re-scrub, and scopes metrics", async () => {
    const db = connection.db;
    const before = await readOperatorMetrics(db, organizationId);
    const { encounterId } = await setup();
    const initial = await scrubEncounter(db, organizationId, encounterId);
    expect(initial.totalUnits).toBe(3);
    expect((await readOperatorMetrics(db, organizationId)).unitsLeftOnTable).toBe(before.unitsLeftOnTable);
    await db.update(s.claimLines).set({ units: 1 }).where(and(
      eq(s.claimLines.claimId, initial.claimId), eq(s.claimLines.cptCode, "97110")));
    const underbilled = await scrubEncounter(db, organizationId, encounterId);
    expect(underbilled).toMatchObject({ status: "SCRUBBED", totalUnits: 2, totalChargeCents: 9000 });
    const actual = await readOperatorMetrics(db, organizationId);
    expect(actual.unitsLeftOnTable).toBe(before.unitsLeftOnTable + 1);
    expect(actual.centsLeftOnTable).toBe(before.centsLeftOnTable + 4500);
    await scrubEncounter(db, organizationId, encounterId);
    expect(await readOperatorMetrics(db, organizationId)).toEqual(actual);
    expect((await readOperatorMetrics(db, randomUUID())).claimCount).toBe(0);
  });
});
