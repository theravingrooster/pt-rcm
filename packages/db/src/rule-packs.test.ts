import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, currentRulePack, promoteRulePackInTransaction,
  scrubEncounter, shadowScrubEncounter, submitScrubbedClaim, upsertEncounter, type Database } from "./index.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization } from "./seed-data.js";
import * as s from "./schema.js";

const url = process.env.TEST_DATABASE_URL;
const example = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;

describe.skipIf(!url)("versioned rule pack lifecycle", () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(async () => { connection = createDatabase(url!); await seedSyntheticData(connection.db); });
  afterAll(async () => { if (connection) await connection.client.end(); });

  it("keeps shadow evaluation nonmutating, requires claim evidence, and excludes the retired pack after an atomic promotion", async () => {
    await expect(connection.db.transaction(async (tx) => {
      const scoped = tx as unknown as Database; // Drizzle nested transactions use savepoints.
      const input: EncounterIngestInput = { ...structuredClone(example), externalId: `SYN-PACK-${randomUUID()}`,
        patient: { ...structuredClone(example.patient), externalId: `SYN-PACK-PAT-${randomUUID()}` },
        minuteLines: [{ cptCode: "97110", minutes: 68 }] };
      const { encounterId } = await upsertEncounter(scoped, seedOrganization.id, input);
      await expect(shadowScrubEncounter(scoped, seedOrganization.id, encounterId))
        .rejects.toMatchObject({ code: "SHADOW_REQUIRES_CLAIM" });
      await expect(promoteRulePackInTransaction(tx, "2"))
        .rejects.toMatchObject({ code: "SHADOW_EVIDENCE_REQUIRED" });
      await expect(promoteRulePackInTransaction(tx, "3"))
        .rejects.toMatchObject({ code: "SHADOW_EVIDENCE_REQUIRED" });

      const active = await scrubEncounter(scoped, seedOrganization.id, encounterId);
      expect(active.status).toBe("SCRUBBED");
      expect(active.totalUnits).toBe(5);
      expect(active.findings.some((finding) => finding.ruleId === "timed-code-cap")).toBe(false);
      const [claimBefore] = await tx.select().from(s.claims).where(eq(s.claims.id, active.claimId));
      const linesBefore = await tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, active.claimId));
      const [encounterBefore] = await tx.select().from(s.encounters).where(eq(s.encounters.id, encounterId));
      const tasksBefore = await tx.select().from(s.tasks).where(eq(s.tasks.claimId, active.claimId));

      const shadow = await shadowScrubEncounter(scoped, seedOrganization.id, encounterId);
      expect(shadow).toMatchObject({ claimId: active.claimId, version: 1, status: "SCRUBBED", totalUnits: 5,
        rulePack: { version: 3, mode: "shadow" }, blocks: [], downgrades: [], submissionAllowed: true });
      expect(shadow.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "timed-code-cap", outcome: "FLAG", code: "TIMED_CODE_CAP", shadow: true }),
        expect.objectContaining({ ruleId: "coverage-inactive", outcome: "FLAG", code: "ELIGIBILITY_NOT_RUN", shadow: true }),
      ]));
      expect(await tx.select().from(s.claims).where(eq(s.claims.id, active.claimId))).toEqual([claimBefore]);
      expect(await tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, active.claimId))).toEqual(linesBefore);
      expect(await tx.select().from(s.encounters).where(eq(s.encounters.id, encounterId))).toEqual([encounterBefore]);
      expect(await tx.select().from(s.tasks).where(eq(s.tasks.claimId, active.claimId))).toEqual(tasksBefore);
      const fires = await tx.select().from(s.ruleFires).where(eq(s.ruleFires.claimId, active.claimId));
      const packsBefore = await tx.select().from(s.ruleSets);
      const v1 = packsBefore.find((pack) => pack.version === "1")!;
      const v2 = packsBefore.find((pack) => pack.version === "2")!;
      const v3 = packsBefore.find((pack) => pack.version === "3")!;
      expect(fires.filter((fire) => fire.shadow)).toHaveLength(10);
      expect(fires.filter((fire) => !fire.shadow)).toHaveLength(8);
      expect(fires.filter((fire) => fire.shadow).every((fire) => fire.ruleSetId === v3.id)).toBe(true);
      expect(fires.filter((fire) => fire.ruleSetId === v2.id)).toHaveLength(0);
      expect(fires.filter((fire) => !fire.shadow).every((fire) => fire.ruleSetId === v1.id)).toBe(true);
      const promoted = await promoteRulePackInTransaction(tx, "3");
      expect(promoted).toMatchObject({ version: "3", status: "ACTIVE", retiredVersion: "1", testedClaimId: active.claimId });
      expect((await tx.select().from(s.ruleSets).where(eq(s.ruleSets.id, v1.id)))[0]!.status).toBe("RETIRED");
      expect((await currentRulePack(tx, "ACTIVE")).pack.rules.map((rule) => rule.id)).toContain("timed-code-cap");
      expect((await currentRulePack(tx, "ACTIVE")).pack.rules.map((rule) => rule.id)).toContain("coverage-inactive");
      await expect(promoteRulePackInTransaction(tx, "1"))
        .rejects.toMatchObject({ code: "RULE_PACK_NOT_SHADOW" });
      const after = await scrubEncounter(scoped, seedOrganization.id, encounterId);
      expect(after.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "timed-code-cap", outcome: "FLAG", shadow: false }),
        expect.objectContaining({ ruleId: "coverage-inactive", outcome: "FLAG", code: "ELIGIBILITY_NOT_RUN", shadow: false }),
      ]));
      expect(after.findings).toHaveLength(10);
      const newFires = await tx.select().from(s.ruleFires).where(and(eq(s.ruleFires.claimId, active.claimId), eq(s.ruleFires.shadow, false)));
      expect(newFires.filter((fire) => fire.ruleSetId === v1.id)).toHaveLength(8);
      expect(newFires.filter((fire) => fire.ruleSetId === v2.id)).toHaveLength(0);
      expect(newFires.filter((fire) => fire.ruleSetId === v3.id)).toHaveLength(10);

      const missingInput: EncounterIngestInput = { ...structuredClone(example), externalId: `SYN-MISSING-${randomUUID()}`,
        patient: { ...structuredClone(example.patient), externalId: `SYN-MISSING-PAT-${randomUUID()}` } };
      const missing = await upsertEncounter(scoped, seedOrganization.id, missingInput);
      const missingScrub = await scrubEncounter(scoped, seedOrganization.id, missing.encounterId);
      expect(missingScrub).toMatchObject({ status: "SCRUBBED", submissionAllowed: true });
      expect(missingScrub.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "coverage-inactive", outcome: "FLAG", code: "ELIGIBILITY_NOT_RUN" }),
      ]));
      const fixture = new FixtureClearinghouse();
      expect(await submitScrubbedClaim(scoped, seedOrganization.id, missingScrub.claimId,
        { adapter: "fixture", clearinghouse: fixture })).toMatchObject({ status: "SUBMITTED" });
      expect(fixture.calls).toHaveLength(1);

      const [coverage] = await tx.select().from(s.coverages).where(eq(s.coverages.patientId, encounterBefore!.patientId));
      await tx.update(s.coverages).set({ eligible: false, planActive: false, checkedAt: new Date().toISOString() })
        .where(eq(s.coverages.id, coverage!.id));
      const blocked = await scrubEncounter(scoped, seedOrganization.id, encounterId);
      expect(blocked).toMatchObject({ claimId: active.claimId, version: 1, status: "BLOCKED", submissionAllowed: false });
      expect(blocked.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "coverage-inactive", outcome: "BLOCK", code: "COVERAGE_INACTIVE" }),
      ]));
      await expect(submitScrubbedClaim(scoped, seedOrganization.id, blocked.claimId,
        { adapter: "fixture", clearinghouse: fixture })).rejects.toMatchObject({ code: "CLAIM_NOT_SUBMITTABLE" });
      expect(fixture.calls).toHaveLength(1);

      await tx.update(s.coverages).set({ checkedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() })
        .where(eq(s.coverages.id, coverage!.id));
      const stale = await scrubEncounter(scoped, seedOrganization.id, encounterId);
      expect(stale).toMatchObject({ claimId: active.claimId, version: 1, status: "SCRUBBED", submissionAllowed: true });
      expect(stale.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "coverage-inactive", outcome: "FLAG", code: "ELIGIBILITY_STALE" }),
      ]));
      expect((await tx.select().from(s.ruleFires).where(and(eq(s.ruleFires.claimId, active.claimId), eq(s.ruleFires.ruleSetId, v2.id))))).toHaveLength(0);
      // The expected constraint error ends this outer transaction, rolling
      // the temporary promotion back without a nested savepoint in PGlite.
      await tx.update(s.ruleSets).set({ notes: "SYN attempted rewrite" }).where(eq(s.ruleSets.id, v1.id));
    })).rejects.toMatchObject({ code: "23514" });
    // The rejecting connection can retain an aborted state in PGlite. Verify
    // the rollback from a new connection so the test checks persisted state.
    const verification = createDatabase(url!);
    try {
      expect((await currentRulePack(verification.db, "ACTIVE")).row.version).toBe("1");
      expect((await currentRulePack(verification.db, "SHADOW")).row.version).toBe("3");
    } finally { await verification.client.end(); }
  });

  it("rejects edits to the active pack", async () => {
    const isolated = createDatabase(url!);
    try {
      const [active] = await isolated.db.select().from(s.ruleSets).where(eq(s.ruleSets.status, "ACTIVE"));
      await expect(isolated.db.update(s.ruleSets).set({ notes: "SYN attempted rewrite" }).where(eq(s.ruleSets.id, active!.id)))
        .rejects.toMatchObject({ code: "23514" });
    } finally { await isolated.client.end(); }
  });

  it.each(["status", "definition"] as const)("rejects %s changes to a tested shadow pack", async (change) => {
    const isolated = createDatabase(url!);
    let shadowId: string;
    try {
      const packs = await isolated.db.select().from(s.ruleSets);
      const v1 = packs.find((pack) => pack.version === "1")!;
      const v3 = packs.find((pack) => pack.version === "3")!;
      shadowId = v3.id;
      await expect(isolated.db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        const input: EncounterIngestInput = { ...structuredClone(example), externalId: `SYN-IMMUTABLE-${randomUUID()}`,
          patient: { ...structuredClone(example.patient), externalId: `SYN-IMMUTABLE-PAT-${randomUUID()}` } };
        const { encounterId } = await upsertEncounter(scoped, seedOrganization.id, input);
        await scrubEncounter(scoped, seedOrganization.id, encounterId);
        await shadowScrubEncounter(scoped, seedOrganization.id, encounterId);
        await tx.update(s.ruleSets).set(change === "status" ? { status: "DRAFT" } : { definitionJson: v1.definitionJson })
          .where(eq(s.ruleSets.id, v3.id));
      })).rejects.toMatchObject({ code: "23514" });
    } finally { await isolated.client.end(); }
    const verification = createDatabase(url!);
    try {
      expect((await verification.db.select().from(s.ruleSets).where(eq(s.ruleSets.id, shadowId)))[0]!.status).toBe("SHADOW");
    } finally { await verification.client.end(); }
  });
});
