import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { ClaimNotSubmittable, ClaimStatusSchema, IllegalClaimTransition, type EncounterIngestInput } from "@pt-rcm/domain";
import { completeTask, createDatabase, getClaimDocument, listTasks, scrubEncounter, submitScrubbedClaim, transitionStoredClaim, upsertEncounter } from "./index.js";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
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
            const tasks = await tx.select({ id: s.tasks.id }).from(s.tasks).where(inArray(s.tasks.claimId, claimIds));
            if (tasks.length) await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, tasks.map((task) => task.id)));
            await tx.delete(s.tasks).where(inArray(s.tasks.claimId, claimIds));
            await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, claimIds));
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

  it.each(["SUBMITTED", "ACCEPTED", "REJECTED", "PAID", "PATIENT_BALANCE", "SHADOWED"] as const)("rejects re-scrub after %s and respects organization scope", async (status) => {
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

  describe("claim document reads", () => {
    it("projects the applied GP downgrade and three allocated units without writing anything", async () => {
      const { encounterId } = await create();
      const result = await scrub(encounterId);
      const before = await stored(result.claimId);
      const document = await getClaimDocument(connection.db, organizationId, result.claimId);
      expect(document).toMatchObject({
        claimId: result.claimId, claimVersion: 1, totalChargeCents: 13500,
        benefitsAssigned: true, acceptAssignment: true,
        billingProvider: { npi: seedOrganization.billingNpi, tin: seedOrganization.taxId },
        renderingProvider: { npi: seedProviders[0]!.npi },
        receiver: { id: seedPayers[0]!.id },
        diagnoses: [{ icd10: "M25.511", pointer: 0 }],
      });
      expect(document.lines).toEqual(result.lines.map(({ cptCode, modifiers, units, diagnosisPointers }, index) => ({
        cptCode, modifiers, units, diagnosisPointers, chargeCents: before.lines[index]!.chargeCents,
      })));
      expect(document.lines.map((line) => [line.units, line.modifiers])).toEqual([[2, ["GP"]], [1, ["GP"]]]);
      expect(await getClaimDocument(connection.db, organizationId, result.claimId)).toEqual(document);
      expect(await stored(result.claimId)).toEqual(before);
    });

    it.each(["BLOCKED", "DRAFT", "SHADOWED"] as const)("refuses a %s claim with ClaimNotSubmittable", async (status) => {
      const body = input(); delete body.planOfCare;
      const { encounterId } = await create(body);
      const result = await scrub(encounterId);
      if (status !== "BLOCKED") await connection.db.update(s.claims).set({ status }).where(eq(s.claims.id, result.claimId));
      await expect(getClaimDocument(connection.db, organizationId, result.claimId)).rejects.toBeInstanceOf(ClaimNotSubmittable);
    });

    it("keeps the old version's service date, diagnoses and coverage after ingestion edits", async () => {
      const body = input();
      const { encounterId } = await create(body);
      const result = await scrub(encounterId);
      const original = await getClaimDocument(connection.db, organizationId, result.claimId);
      body.dateOfService = "2026-10-02";
      body.diagnoses = ["M25.512"];
      body.patient.coverage.memberId = "SYN-CHANGED-MEMBER";
      body.minuteLines = [{ cptCode: "97110", minutes: 8 }];
      await create(body);
      expect(await getClaimDocument(connection.db, organizationId, result.claimId)).toEqual(original);
    });

    it("uses only billed lines and preserves a zero-unit source in the claim snapshot", async () => {
      const body = input(); body.minuteLines = [{ cptCode: "97110", minutes: 23 }, { cptCode: "97140", minutes: 8 }];
      const { encounterId } = await create(body);
      const result = await scrub(encounterId);
      const document = await getClaimDocument(connection.db, organizationId, result.claimId);
      expect(document.lines).toMatchObject([{ cptCode: "97110", units: 2, modifiers: ["GP"] }]);
      expect(document.lines).toHaveLength(1);
      expect(document.totalChargeCents).toBe(9000);
    });

    it("returns not found for a missing claim or the wrong organization", async () => {
      const { encounterId } = await create(); const result = await scrub(encounterId);
      await expect(getClaimDocument(connection.db, seedOrganization.id, result.claimId)).rejects.toMatchObject({ status: 404, code: "CLAIM_NOT_FOUND" });
      await expect(getClaimDocument(connection.db, organizationId, randomUUID())).rejects.toMatchObject({ status: 404, code: "CLAIM_NOT_FOUND" });
    });

    it.each([{ units: 3 }, { modifiers: [] }, { chargeCents: 1 }, { diagnosisPointers: [99] }])("rejects saved line changes after the scrub %j", async (changes) => {
      const { encounterId } = await create(); const result = await scrub(encounterId);
      const saved = await stored(result.claimId);
      await connection.db.update(s.claimLines).set(changes).where(eq(s.claimLines.id, saved.lines[0]!.id));
      await expect(getClaimDocument(connection.db, organizationId, result.claimId)).rejects.toMatchObject({ status: 422, code: "INVALID_CLAIM_DOCUMENT" });
    });
  });

  describe("fixture claim submission", () => {
    it("records the exact document, stores the ICN and audit, and only marks SUBMITTED", async () => {
      const { encounterId } = await create(); const scrubbed = await scrub(encounterId);
      const document = await getClaimDocument(connection.db, organizationId, scrubbed.claimId);
      const clearinghouse = new FixtureClearinghouse();
      const result = await submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter: "fixture", clearinghouse });
      expect(result).toMatchObject({ claimId: scrubbed.claimId, status: "SUBMITTED", icn: `SYN-ICN-${scrubbed.claimId}` });
      expect(clearinghouse.calls).toEqual([{ method: "submitClaim", document }]);
      const saved = await stored(scrubbed.claimId);
      expect(saved.claim).toMatchObject({ status: "SUBMITTED", totalChargeCents: 13500, snapshotJson: {
        submission: { adapter: "fixture", acknowledgment: result.acknowledgment, document, submittedAt: expect.stringMatching(/Z$/) },
      } });
      expect(saved.fires).toHaveLength(8);
      const audits = await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, scrubbed.claimId));
      expect(audits).toMatchObject([{ actor: "SYN-FIXTURE-SUBMIT", action: "CLAIM_SUBMITTED", entity: "Claim",
        detailJson: { adapter: "fixture", icn: result.icn, acknowledgmentStatus: "accepted-for-processing" } }]);
      expect((await connection.db.select().from(s.encounters).where(eq(s.encounters.id, encounterId)))[0]!.status).toBe("CLAIMED");
      await expect(submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter: "fixture", clearinghouse })).rejects.toBeInstanceOf(ClaimNotSubmittable);
      expect(clearinghouse.calls).toHaveLength(1);
    });

    it.each(ClaimStatusSchema.options.filter((status) => status !== "SCRUBBED"))("refuses %s before calling the adapter", async (status) => {
      const { encounterId } = await create(); const scrubbed = await scrub(encounterId);
      await connection.db.update(s.claims).set({ status }).where(eq(s.claims.id, scrubbed.claimId));
      const clearinghouse = new FixtureClearinghouse();
      const before = await stored(scrubbed.claimId);
      await expect(submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter: "fixture", clearinghouse })).rejects.toBeInstanceOf(ClaimNotSubmittable);
      expect(clearinghouse.calls).toEqual([]);
      expect(await stored(scrubbed.claimId)).toEqual(before);
    });

    it.each([undefined, "", "stedi", "Fixture"])("refuses adapter %s without any submit", async (adapter) => {
      const { encounterId } = await create(); const scrubbed = await scrub(encounterId);
      const clearinghouse = new FixtureClearinghouse();
      await expect(submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter, clearinghouse })).rejects.toMatchObject({ status: 503, code: "CLEARINGHOUSE_ADAPTER_DISABLED" });
      expect(clearinghouse.calls).toEqual([]);
      expect((await stored(scrubbed.claimId)).claim!.status).toBe("SCRUBBED");
    });

    it("serializes duplicate requests to exactly one fixture call and one audit", async () => {
      const { encounterId } = await create(); const scrubbed = await scrub(encounterId);
      const clearinghouse = new FixtureClearinghouse();
      const results = await Promise.allSettled([1, 2].map(() => submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter: "fixture", clearinghouse })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(clearinghouse.calls).toHaveLength(1);
      expect(await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, scrubbed.claimId))).toHaveLength(1);
    });

    it("requires a new scrub after encounter edits and refuses superseded versions", async () => {
      const body = input(); const { encounterId } = await create(body); const first = await scrub(encounterId);
      body.minuteLines = [{ cptCode: "97110", minutes: 8 }]; await create(body);
      const clearinghouse = new FixtureClearinghouse();
      const options = { adapter: "fixture", clearinghouse };
      await expect(submitScrubbedClaim(connection.db, organizationId, first.claimId, options)).rejects.toMatchObject({ code: "CLAIM_NEEDS_SCRUB" });
      const latest = await scrub(encounterId);
      await expect(submitScrubbedClaim(connection.db, organizationId, first.claimId, options)).rejects.toMatchObject({ code: "CLAIM_SUPERSEDED" });
      expect(clearinghouse.calls).toEqual([]);
      expect((await submitScrubbedClaim(connection.db, organizationId, latest.claimId, options)).status).toBe("SUBMITTED");
    });

    it("rejects a wrong organization and missing claim before any adapter call", async () => {
      const { encounterId } = await create(); const scrubbed = await scrub(encounterId);
      const clearinghouse = new FixtureClearinghouse();
      await expect(submitScrubbedClaim(connection.db, seedOrganization.id, scrubbed.claimId, { adapter: "fixture", clearinghouse })).rejects.toMatchObject({ status: 404 });
      await expect(submitScrubbedClaim(connection.db, organizationId, randomUUID(), { adapter: "fixture", clearinghouse })).rejects.toMatchObject({ status: 404 });
      expect(clearinghouse.calls).toEqual([]);
    });

    it("refuses post-scrub line edits before the adapter sees a document", async () => {
      const { encounterId } = await create(); const scrubbed = await scrub(encounterId);
      const saved = await stored(scrubbed.claimId);
      await connection.db.update(s.claimLines).set({ units: 3 }).where(eq(s.claimLines.id, saved.lines[0]!.id));
      const clearinghouse = new FixtureClearinghouse();
      await expect(submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter: "fixture", clearinghouse })).rejects.toMatchObject({ status: 422 });
      expect(clearinghouse.calls).toEqual([]);
    });

    it("does not change status or write an audit when the adapter fails or acknowledges incorrectly", async () => {
      const { encounterId } = await create(); const scrubbed = await scrub(encounterId);
      const clearinghouse = new FixtureClearinghouse();
      const submit = vi.spyOn(clearinghouse, "submitClaim").mockRejectedValueOnce(new Error("SYN local failure"));
      await expect(submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter: "fixture", clearinghouse })).rejects.toThrow("SYN local failure");
      submit.mockResolvedValueOnce({ icn: "INVALID", status: "accepted-for-processing" });
      await expect(submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter: "fixture", clearinghouse })).rejects.toMatchObject({ code: "INVALID_SUBMIT_ACK" });
      submit.mockRestore();
      expect((await stored(scrubbed.claimId)).claim).toMatchObject({ status: "SCRUBBED" });
      expect(await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, scrubbed.claimId))).toEqual([]);
    });
  });

  describe("claim lifecycle and operator tasks", () => {
    const change = (id: string, status: Parameters<typeof transitionStoredClaim>[3]) => transitionStoredClaim(connection.db, organizationId, id, status);
    const tasksFor = async (id: string) => (await listTasks(connection.db, organizationId)).filter((task) => task.claimId === id);
    async function submitted() {
      const { encounterId } = await create();
      const claim = await scrub(encounterId);
      const clearinghouse = new FixtureClearinghouse();
      await submitScrubbedClaim(connection.db, organizationId, claim.claimId, { adapter: "fixture", clearinghouse });
      return { ...claim, clearinghouse };
    }

    it("concurrent blocked scrubs open one RULE_BLOCK task, and recovery does not silently close it", async () => {
      const body = input(); delete body.planOfCare;
      const { encounterId, patientId } = await create(body);
      const results = await Promise.all([scrub(encounterId), scrub(encounterId)]);
      expect(results[0]!.claimId).toBe(results[1]!.claimId);
      const claimId = results[0]!.claimId;
      expect(await tasksFor(claimId)).toMatchObject([{ kind: "RULE_BLOCK", status: "OPEN", owner: "OPERATOR", reason: expect.stringContaining("POC_INVALID") }]);
      await connection.db.insert(s.plansOfCare).values({ patientId, signedDate: body.dateOfService, certifyingNpi: "0000000003", expiresOn: null });
      expect(await scrub(encounterId)).toMatchObject({ claimId, status: "SCRUBBED", version: 1 });
      expect(await tasksFor(claimId)).toHaveLength(1);
    });

    it("completes a task once, audits it atomically, and allows a later block to open a new task", async () => {
      const body = input(); delete body.planOfCare;
      const { encounterId } = await create(body); const { claimId } = await scrub(encounterId);
      const [task] = await tasksFor(claimId);
      const before = await stored(claimId);
      const results = await Promise.all([1, 2].map(() => completeTask(connection.db, organizationId, task!.id)));
      expect(results).toEqual([ { ...task, status: "DONE" }, { ...task, status: "DONE" } ]);
      expect(await tasksFor(claimId)).toEqual([]);
      expect((await listTasks(connection.db, organizationId, "DONE")).filter((row) => row.claimId === claimId)).toEqual([{ ...task, status: "DONE" }]);
      expect(await stored(claimId)).toEqual(before);
      const audits = await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, task!.id));
      expect(audits).toMatchObject([{ actor: "SYN-OPERATOR", action: "TASK_COMPLETED", entity: "Task", at: expect.stringMatching(/Z$/),
        detailJson: { claimId, kind: "RULE_BLOCK", from: "OPEN", to: "DONE" } }]);
      await scrub(encounterId);
      const reopened = await tasksFor(claimId);
      expect(reopened).toHaveLength(1);
      expect(reopened[0]!.id).not.toBe(task!.id);
    });

    it("scopes task listing and completion to the server organization", async () => {
      const body = input(); delete body.planOfCare;
      const { encounterId } = await create(body); const { claimId } = await scrub(encounterId);
      const [task] = await tasksFor(claimId);
      expect((await listTasks(connection.db, seedOrganization.id)).some((row) => row.id === task!.id)).toBe(false);
      await expect(completeTask(connection.db, seedOrganization.id, task!.id)).rejects.toMatchObject({ status: 404, code: "TASK_NOT_FOUND" });
      await expect(completeTask(connection.db, organizationId, randomUUID())).rejects.toMatchObject({ status: 404 });
      expect(await tasksFor(claimId)).toEqual([task]);
      expect(await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, task!.id))).toEqual([]);
    });

    it.each([
      ["DENIED", "DENIAL_REVIEW"], ["PATIENT_BALANCE", "PATIENT_INVOICE"], ["PAID", null],
    ] as const)("records ACCEPTED -> %s and creates the corresponding task", async (status, kind) => {
      const claim = await submitted();
      await change(claim.claimId, "ACCEPTED");
      expect(await change(claim.claimId, status)).toMatchObject({ status, version: 1 });
      const tasks = await tasksFor(claim.claimId);
      if (kind) expect(tasks).toMatchObject([{ kind, status: "OPEN", owner: "OPERATOR" }]);
      else expect(tasks).toEqual([]);
      await expect(change(claim.claimId, status)).rejects.toBeInstanceOf(IllegalClaimTransition);
      expect(await tasksFor(claim.claimId)).toEqual(tasks);
      expect(claim.clearinghouse.calls).toHaveLength(1); // Recording outcomes performs no I/O.
    });

    it("denial retries keep identity and increment version only after a successful scrub", async () => {
      const claim = await submitted();
      await change(claim.claimId, "ACCEPTED"); await change(claim.claimId, "DENIED");
      const before = await stored(claim.claimId);
      await connection.db.update(s.claimLines).set({ units: 3 }).where(eq(s.claimLines.id, before.lines[0]!.id));
      expect(await scrub(claim.encounterId)).toMatchObject({ claimId: claim.claimId, status: "DENIED", version: 1, submissionAllowed: false });
      expect((await tasksFor(claim.claimId)).map((task) => task.kind).sort()).toEqual(["DENIAL_REVIEW", "RULE_BLOCK"]);
      expect((await stored(claim.claimId)).claim!.snapshotJson.submission).toEqual(before.claim!.snapshotJson.submission);
      await connection.db.update(s.claimLines).set({ units: 2 }).where(eq(s.claimLines.id, before.lines[0]!.id));
      expect(await scrub(claim.encounterId)).toMatchObject({ claimId: claim.claimId, status: "SCRUBBED", version: 2 });
      expect(await scrub(claim.encounterId)).toMatchObject({ claimId: claim.claimId, status: "SCRUBBED", version: 2 });
      const corrected = await stored(claim.claimId);
      expect(corrected.claim!.snapshotJson.submission).toBeUndefined();
      expect(corrected.claim!.snapshotJson.submissionHistory).toEqual([{ version: 1, submission: before.claim!.snapshotJson.submission }]);
      expect((await submitScrubbedClaim(connection.db, organizationId, claim.claimId, { adapter: "fixture", clearinghouse: claim.clearinghouse })).status).toBe("SUBMITTED");
      expect((await stored(claim.claimId)).claim!.version).toBe(2);
      expect(claim.clearinghouse.calls).toHaveLength(2);
    });

    it("requires REJECTED -> DRAFT before re-scrubbing and resubmitting", async () => {
      const claim = await submitted(); await change(claim.claimId, "REJECTED");
      await expect(scrub(claim.encounterId)).rejects.toMatchObject({ status: 409 });
      expect(await change(claim.claimId, "DRAFT")).toMatchObject({ status: "DRAFT", version: 1 });
      expect(await scrub(claim.encounterId)).toMatchObject({ status: "SCRUBBED", version: 1, claimId: claim.claimId });
      await submitScrubbedClaim(connection.db, organizationId, claim.claimId, { adapter: "fixture", clearinghouse: claim.clearinghouse });
      expect(claim.clearinghouse.calls).toHaveLength(2);
    });

    it("rejects skipped, cross-organization, and superseded transitions without tasks or state changes", async () => {
      const claim = await submitted(); const before = await stored(claim.claimId);
      await expect(change(claim.claimId, "DENIED")).rejects.toBeInstanceOf(IllegalClaimTransition);
      expect(await stored(claim.claimId)).toEqual(before);
      expect(await tasksFor(claim.claimId)).toEqual([]);
      await expect(transitionStoredClaim(connection.db, seedOrganization.id, claim.claimId, "ACCEPTED")).rejects.toMatchObject({ status: 404 });
      await expect(change(randomUUID(), "ACCEPTED")).rejects.toMatchObject({ status: 404 });
      const body = input(); const { encounterId } = await create(body); const first = await scrub(encounterId);
      body.minuteLines = [{ cptCode: "97110", minutes: 8 }]; await create(body); await scrub(encounterId);
      await expect(change(first.claimId, "DRAFT")).rejects.toMatchObject({ status: 409, code: "CLAIM_SUPERSEDED" });
    });
  });

  it("rolls back claim creation when RuleFire persistence fails", async () => {
    const { encounterId } = await create();
    const spy = vi.spyOn(ruleFireRepository, "createRuleFireRepository").mockReturnValueOnce({ insertRuleFires: async () => { throw new Error("SYN audit failure"); } });
    try { await expect(scrub(encounterId)).rejects.toThrow("SYN audit failure"); } finally { spy.mockRestore(); }
    expect(await connection.db.select().from(s.claims).where(eq(s.claims.encounterId, encounterId))).toEqual([]);
  });
});
