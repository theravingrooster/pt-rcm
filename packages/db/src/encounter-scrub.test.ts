import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, scrubEncounter, upsertEncounter } from "./index.js";
import * as ruleFireRepository from "./rule-fire-repository.js";
import * as s from "./schema.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedFacility, seedOrganization, seedPayers, seedProviders } from "./seed-data.js";

const url = process.env.TEST_DATABASE_URL;
const example = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;
const organizationId = randomUUID();
const facilityId = randomUUID();
function input(): EncounterIngestInput {
  return { ...structuredClone(example), externalId: `SYN-SCRUB-${randomUUID()}`, facilityId,
    patient: { ...structuredClone(example.patient), externalId: `SYN-PAT-${randomUUID()}` },
    minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }] };
}

describe.skipIf(!url)("transactional PT scrub", () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    connection = createDatabase(url!);
    await seedSyntheticData(connection.db);
    await connection.db.insert(s.organizations).values({ ...seedOrganization, id: organizationId, name: "SYN Scrub Test" });
    await connection.db.insert(s.serviceFacilities).values({ ...seedFacility, id: facilityId, organizationId });
    await connection.db.insert(s.providers).values({ ...seedProviders[0]!, id: randomUUID(), organizationId });
  });
  afterAll(async () => {
    if (!connection) return;
    try {
      await connection.db.transaction(async (tx) => {
        const encounters = await tx.select({ id: s.encounters.id }).from(s.encounters).where(eq(s.encounters.organizationId, organizationId));
        const encounterIds = encounters.map((row) => row.id);
        if (encounterIds.length) {
          const claims = await tx.select({ id: s.claims.id }).from(s.claims).where(inArray(s.claims.encounterId, encounterIds));
          if (claims.length) {
            const claimIds = claims.map((row) => row.id);
            await tx.delete(s.ruleFires).where(inArray(s.ruleFires.claimId, claimIds));
            await tx.delete(s.claimLines).where(inArray(s.claimLines.claimId, claimIds));
            await tx.delete(s.claims).where(inArray(s.claims.id, claimIds));
          }
          await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, encounterIds));
          await tx.delete(s.encounterMinuteLines).where(inArray(s.encounterMinuteLines.encounterId, encounterIds));
          await tx.delete(s.diagnoses).where(inArray(s.diagnoses.encounterId, encounterIds));
          await tx.delete(s.encounters).where(inArray(s.encounters.id, encounterIds));
        }
        const patients = await tx.select({ id: s.patients.id }).from(s.patients).where(eq(s.patients.organizationId, organizationId));
        const patientIds = patients.map((row) => row.id);
        if (patientIds.length) {
          await tx.delete(s.plansOfCare).where(inArray(s.plansOfCare.patientId, patientIds));
          await tx.delete(s.authorizations).where(inArray(s.authorizations.patientId, patientIds));
          await tx.delete(s.coverages).where(inArray(s.coverages.patientId, patientIds));
          await tx.delete(s.patients).where(inArray(s.patients.id, patientIds));
        }
        await tx.delete(s.providers).where(eq(s.providers.organizationId, organizationId));
        await tx.delete(s.serviceFacilities).where(eq(s.serviceFacilities.organizationId, organizationId));
        await tx.delete(s.organizations).where(eq(s.organizations.id, organizationId));
      });
    } finally { await connection.client.end(); }
  });
  async function create(body = input()) { return upsertEncounter(connection.db, organizationId, body); }
  async function scrub(encounterId: string) { return scrubEncounter(connection.db, organizationId, encounterId); }
  async function stored(claimId: string) {
    const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.id, claimId));
    const lines = await connection.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).orderBy(s.claimLines.cptCode);
    const fires = await connection.db.select().from(s.ruleFires).where(eq(s.ruleFires.claimId, claimId)).orderBy(s.ruleFires.ruleId);
    return { claim, lines, fires };
  }

  it("shoulder 20+20 allocates three units, adds GP, prices in cents, and persists all eight active findings", async () => {
    const { encounterId } = await create();
    const result = await scrub(encounterId);
    expect(result).toMatchObject({ status: "SCRUBBED", totalUnits: 3, totalChargeCents: 13500, submissionAllowed: true, version: 1 });
    const saved = await stored(result.claimId);
    expect(saved.lines).toMatchObject([
      { cptCode: "97110", minutes: 20, units: 2, modifiers: ["GP"], chargeCents: 9000, diagnosisPointers: [0] },
      { cptCode: "97530", minutes: 20, units: 1, modifiers: ["GP"], chargeCents: 4500, diagnosisPointers: [0] },
    ]);
    expect(saved.fires).toHaveLength(8);
    expect(saved.fires.every((fire) => !fire.shadow && fire.ruleVersion === "1")).toBe(true);
    expect(saved.fires.find((fire) => fire.ruleId === "gp-modifier")).toMatchObject({ outcome: "DOWNGRADE", detailJson: { code: "MISSING_GP" } });
    expect(saved.claim).toMatchObject({ status: "SCRUBBED", snapshotJson: { rulePack: { id: "outpatient-pt", version: 1, mode: "active" }, yearToDateBilledCents: 0 } });
    const repeat = await scrub(encounterId);
    expect(repeat).toMatchObject({ claimId: result.claimId, version: 1, status: "SCRUBBED", totalUnits: 3 });
    expect((await stored(result.claimId)).fires).toHaveLength(16);
    expect(repeat.findings.find((finding) => finding.ruleId === "gp-modifier")).toMatchObject({ outcome: "PASS" });
  });

  it("the same shoulder with four stored units blocks OVERBILLED_UNITS without silently reallocating", async () => {
    const { encounterId } = await create();
    const first = await scrub(encounterId);
    const saved = await stored(first.claimId);
    await connection.db.update(s.claimLines).set({ units: 3 }).where(eq(s.claimLines.id, saved.lines[0]!.id));
    const result = await scrub(encounterId);
    expect(result).toMatchObject({ claimId: first.claimId, status: "BLOCKED", totalUnits: 4, totalChargeCents: 18000, submissionAllowed: false });
    expect(result.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OVERBILLED_UNITS" })]));
    expect((await stored(result.claimId)).claim!.status).toBe("BLOCKED");
  });

  it("missing POC blocks the shoulder claim", async () => {
    const body = input();
    delete body.planOfCare;
    const { encounterId } = await create(body);
    const result = await scrub(encounterId);
    expect(result.status).toBe("BLOCKED");
    expect(result.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "POC_INVALID" })]));
  });

  it("underbilling is flagged with unitsLeftOnTable and never increased", async () => {
    const { encounterId } = await create();
    const first = await scrub(encounterId);
    const saved = await stored(first.claimId);
    await connection.db.update(s.claimLines).set({ units: 1 }).where(eq(s.claimLines.id, saved.lines[0]!.id));
    const result = await scrub(encounterId);
    expect(result).toMatchObject({ totalUnits: 2, totalChargeCents: 9000, status: "SCRUBBED" });
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNDERBILLED_UNITS", detail: { lineIndexes: [0], unitsLeftOnTable: 1 } })]));
    expect((await stored(first.claimId)).fires).toEqual(expect.arrayContaining([expect.objectContaining({ detailJson: expect.objectContaining({ code: "UNDERBILLED_UNITS", unitsLeftOnTable: 1 }) })]));
  });

  it.each([
    { lines: [{ cptCode: "97110", minutes: 0 }], units: 0, cents: 0, status: "BLOCKED", storedCount: 0 },
    { lines: [{ cptCode: "97110", minutes: 23 }, { cptCode: "97140", minutes: 8 }], units: 2, cents: 9000, status: "SCRUBBED", storedCount: 1 },
    { lines: [{ cptCode: "97161", minutes: 0 }, { cptCode: "97110", minutes: 8 }, { cptCode: "G0283", minutes: 0 }], units: 3, cents: 18500, status: "SCRUBBED", storedCount: 3 },
  ])("preserves all source lines while pricing allocated units: $lines", async ({ lines, units, cents, status, storedCount }) => {
    const body = input(); body.minuteLines = lines;
    const { encounterId } = await create(body);
    const result = await scrub(encounterId);
    expect(result).toMatchObject({ totalUnits: units, totalChargeCents: cents, status });
    expect(result.lines).toHaveLength(lines.length);
    const saved = await stored(result.claimId);
    expect(saved.lines).toHaveLength(storedCount);
    expect(saved.claim!.snapshotJson.draftClaim).toMatchObject({ lines: result.lines });
    expect((await scrub(encounterId)).totalUnits).toBe(units);
  });

  it("edited encounter sources create a new version and retain the old rule evidence", async () => {
    const body = input();
    const { encounterId } = await create(body);
    const first = await scrub(encounterId);
    body.minuteLines = [{ cptCode: "97110", minutes: 8 }];
    await create(body);
    const second = await scrub(encounterId);
    expect(second).toMatchObject({ version: 2, totalUnits: 1, totalChargeCents: 4500 });
    expect(second.claimId).not.toBe(first.claimId);
    expect((await stored(first.claimId)).fires).toHaveLength(8);
  });

  it.each(["SUBMITTED", "PAID"] as const)("rejects re-scrub after %s and respects organization scope", async (status) => {
    const { encounterId } = await create();
    const first = await scrub(encounterId);
    await connection.db.update(s.claims).set({ status }).where(eq(s.claims.id, first.claimId));
    await expect(scrub(encounterId)).rejects.toMatchObject({ status: 409, code: "CLAIM_ALREADY_SUBMITTED" });
    await expect(scrubEncounter(connection.db, seedOrganization.id, encounterId)).rejects.toMatchObject({ status: 404 });
    expect((await stored(first.claimId)).fires).toHaveLength(8);
  });

  it("rejects ambiguous active coverage before creating a claim", async () => {
    const { encounterId, patientId } = await create();
    await connection.db.insert(s.coverages).values({ patientId, payerId: seedPayers[1]!.id, memberId: "SYN-SECOND-COVERAGE", subscriberRelationship: "SELF", active: true });
    await expect(scrub(encounterId)).rejects.toMatchObject({ status: 422, code: "COVERAGE_NOT_UNIQUE" });
    expect(await connection.db.select().from(s.claims).where(eq(s.claims.encounterId, encounterId))).toEqual([]);
  });

  it("uses this patient+payer's latest billed versions in the service year for KX", async () => {
    const body = input();
    const current = await create(body);
    async function prior(dateOfService: string, payerId: string, versions: { version: number; status: "SUBMITTED" | "SCRUBBED"; cents: number }[]) {
      const encounter = await create({ ...body, externalId: `SYN-PRIOR-${randomUUID()}`, dateOfService });
      // Fixture database state only. No submission or clearinghouse adapter.
      await connection.db.insert(s.claims).values(versions.map(({ version, status, cents }) => ({ encounterId: encounter.encounterId, payerId, version, status, totalChargeCents: cents, snapshotJson: {} })));
    }
    const medicare = seedPayers[0]!.id;
    await prior("2026-09-30", medicare, [{ version: 1, status: "SUBMITTED", cents: 250000 }, { version: 2, status: "SUBMITTED", cents: 230000 }]);
    await prior("2025-12-31", medicare, [{ version: 1, status: "SUBMITTED", cents: 90000 }]);
    await prior("2026-10-02", medicare, [{ version: 1, status: "SUBMITTED", cents: 90000 }]);
    await prior("2026-09-30", seedPayers[1]!.id, [{ version: 1, status: "SUBMITTED", cents: 90000 }]);
    await prior("2026-09-30", medicare, [{ version: 1, status: "SCRUBBED", cents: 90000 }]);
    const under = await scrub(current.encounterId);
    expect(under.status).toBe("SCRUBBED");
    expect((await stored(under.claimId)).claim!.snapshotJson.yearToDateBilledCents).toBe(230000);
    await prior("2026-10-01", medicare, [{ version: 1, status: "SUBMITTED", cents: 10000 }]);
    const over = await scrub(current.encounterId);
    expect(over.status).toBe("BLOCKED");
    expect(over.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MISSING_KX", detail: { projectedCents: 253500, thresholdCents: 248000 } })]));
  });

  it("rolls back claim creation when RuleFire persistence fails", async () => {
    const { encounterId } = await create();
    const spy = vi.spyOn(ruleFireRepository, "createRuleFireRepository").mockReturnValueOnce({ insertRuleFires: async () => { throw new Error("SYN audit failure"); } });
    try { await expect(scrub(encounterId)).rejects.toThrow("SYN audit failure"); } finally { spy.mockRestore(); }
    expect(await connection.db.select().from(s.claims).where(eq(s.claims.encounterId, encounterId))).toEqual([]);
  });
});
