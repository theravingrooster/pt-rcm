import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, currentRulePack, getOperatorEncounter, promoteRulePackInTransaction,
  scrubEncounter, shadowScrubEncounter, upsertEncounter, type Database } from "./index.js";
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
    const rollback = new Error("SYN roll back isolated pack lifecycle");
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
        rulePack: { version: 2, mode: "shadow" }, blocks: [], downgrades: [], submissionAllowed: true });
      expect(shadow.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "timed-code-cap", outcome: "FLAG", code: "TIMED_CODE_CAP", shadow: true }),
      ]));
      expect(await tx.select().from(s.claims).where(eq(s.claims.id, active.claimId))).toEqual([claimBefore]);
      expect(await tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, active.claimId))).toEqual(linesBefore);
      expect(await tx.select().from(s.encounters).where(eq(s.encounters.id, encounterId))).toEqual([encounterBefore]);
      expect(await tx.select().from(s.tasks).where(eq(s.tasks.claimId, active.claimId))).toEqual(tasksBefore);
      const fires = await tx.select().from(s.ruleFires).where(eq(s.ruleFires.claimId, active.claimId));
      const packsBefore = await tx.select().from(s.ruleSets);
      const v1 = packsBefore.find((pack) => pack.version === "1")!;
      const v2 = packsBefore.find((pack) => pack.version === "2")!;
      await expect(tx.transaction((nested) => nested.update(s.ruleSets).set({ notes: "SYN attempted rewrite" }).where(eq(s.ruleSets.id, v1.id))))
        .rejects.toMatchObject({ code: "23514" });
      await expect(tx.transaction((nested) => nested.update(s.ruleSets).set({ status: "DRAFT" }).where(eq(s.ruleSets.id, v2.id))))
        .rejects.toMatchObject({ code: "23514" });
      expect(fires.filter((fire) => fire.shadow)).toHaveLength(9);
      expect(fires.filter((fire) => !fire.shadow)).toHaveLength(8);
      expect(fires.filter((fire) => fire.shadow).every((fire) => fire.ruleSetId === v2.id)).toBe(true);
      expect(fires.filter((fire) => !fire.shadow).every((fire) => fire.ruleSetId === v1.id)).toBe(true);
      const comparison = await getOperatorEncounter(scoped, seedOrganization.id, encounterId);
      expect(comparison!.rulePacks).toEqual({ active: "outpatient-pt v1", shadow: "outpatient-pt v2", hasShadow: true });
      expect(comparison!.findings.find((finding) => finding.ruleId === "timed-code-cap"))
        .toMatchObject({ outcome: "FLAG", shadow: true });

      const promoted = await promoteRulePackInTransaction(tx, "2");
      expect(promoted).toMatchObject({ version: "2", status: "ACTIVE", retiredVersion: "1", testedClaimId: active.claimId });
      expect((await tx.select().from(s.ruleSets).where(eq(s.ruleSets.id, v1.id)))[0]!.status).toBe("RETIRED");
      expect((await currentRulePack(tx, "ACTIVE")).pack.rules.map((rule) => rule.id)).toContain("timed-code-cap");
      await expect(tx.transaction((nested) => nested.update(s.ruleSets).set({ definitionJson: v1.definitionJson }).where(eq(s.ruleSets.id, v2.id))))
        .rejects.toMatchObject({ code: "23514" });
      await expect(promoteRulePackInTransaction(tx, "1"))
        .rejects.toMatchObject({ code: "RULE_PACK_NOT_SHADOW" });
      const after = await scrubEncounter(scoped, seedOrganization.id, encounterId);
      expect(after.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "timed-code-cap", outcome: "FLAG", shadow: false }),
      ]));
      expect(after.findings).toHaveLength(9);
      const newFires = await tx.select().from(s.ruleFires).where(and(eq(s.ruleFires.claimId, active.claimId), eq(s.ruleFires.shadow, false)));
      expect(newFires.filter((fire) => fire.ruleSetId === v1.id)).toHaveLength(8);
      expect(newFires.filter((fire) => fire.ruleSetId === v2.id)).toHaveLength(9);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
