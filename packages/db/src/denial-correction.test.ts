import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, getClaimDocument, scrubEncounter, submitScrubbedClaim,
  transitionStoredClaim, upsertEncounter, type Database } from "./index.js";
import { correctDeniedClaim } from "./denial-correction.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization } from "./seed-data.js";
import * as s from "./schema.js";

const url = process.env.TEST_DATABASE_URL;
const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;

describe.skipIf(!url)("denied claim correction", () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(async () => { connection = createDatabase(url!); await seedSyntheticData(connection.db); });
  afterAll(async () => { if (connection) await connection.client.end(); });

  // A savepoint for each service and a final rollback keep this shared test
  // database unchanged, including the active rule pack and clinical records.
  const rollback = new Error("ROLLBACK_SYN_DENIAL_CORRECTION");
  async function withDeniedClaim(run: (db: Database, claimId: string, encounterId: string) => Promise<void>) {
    try { await connection.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const input: EncounterIngestInput = { ...structuredClone(fixture), externalId: `SYN-DENIAL-${randomUUID()}`,
        patient: { ...structuredClone(fixture.patient), externalId: `SYN-DENIAL-PAT-${randomUUID()}` },
        minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }] };
      const { encounterId } = await upsertEncounter(db, seedOrganization.id, input);
      const scrub = await scrubEncounter(db, seedOrganization.id, encounterId);
      expect(scrub).toMatchObject({ status: "SCRUBBED", version: 1, totalUnits: 3 });
      await submitScrubbedClaim(db, seedOrganization.id, scrub.claimId,
        { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
      await transitionStoredClaim(db, seedOrganization.id, scrub.claimId, "ACCEPTED");
      await transitionStoredClaim(db, seedOrganization.id, scrub.claimId, "DENIED");
      await run(db, scrub.claimId, encounterId);
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
  }

  it("changes only operator units/modifiers, re-scrubs and resubmits the same claim at version two", async () => {
    await withDeniedClaim(async (db, claimId, encounterId) => {
      const before = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).orderBy(s.claimLines.cptCode);
      const original = (await db.select().from(s.claims).where(eq(s.claims.id, claimId)))[0]!;
      const result = await correctDeniedClaim(db, seedOrganization.id, claimId, [
        { claimLineId: before[0]!.id, units: 1, modifiers: ["GP"] },
        { claimLineId: before[1]!.id, units: 1, modifiers: ["GP", "59"] },
      ]);
      expect(result).toMatchObject({ claimId, encounterId, status: "SCRUBBED", version: 2, totalUnits: 2, submissionAllowed: true });
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "eight-minute-applied", outcome: "FLAG", code: "UNDERBILLED_UNITS" }),
      ]));
      const document = await getClaimDocument(db, seedOrganization.id, claimId);
      expect(document.claimVersion).toBe(2);
      expect(document.lines.map((line) => ({ cptCode: line.cptCode, units: line.units, modifiers: line.modifiers }))).toEqual([
        { cptCode: "97110", units: 1, modifiers: ["GP"] },
        { cptCode: "97530", units: 1, modifiers: ["GP", "59"] },
      ]);
      const correctedLines = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).orderBy(s.claimLines.cptCode);
      expect(correctedLines.map(({ cptCode, minutes }) => ({ cptCode, minutes })))
        .toEqual(before.map(({ cptCode, minutes }) => ({ cptCode, minutes })));
      const after = (await db.select().from(s.claims).where(eq(s.claims.id, claimId)))[0]!;
      expect(after.snapshotJson.submissionHistory).toEqual([{ version: 1, submission: original.snapshotJson.submission }]);
      expect((await db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, claimId)))
        .filter((event) => event.action === "DENIED_CLAIM_CORRECTED_BY_OPERATOR"))
        .toMatchObject([{ detailJson: { version: 2, resultStatus: "SCRUBBED", changes: expect.arrayContaining([
          expect.objectContaining({ claimLineId: before[0]!.id, to: { units: 1, modifiers: ["GP"] } }),
          expect.objectContaining({ claimLineId: before[1]!.id, to: { units: 1, modifiers: ["GP", "59"] } }),
        ]) } }]);
      const adapter = new FixtureClearinghouse();
      await expect(submitScrubbedClaim(db, seedOrganization.id, claimId,
        { adapter: "fixture", clearinghouse: adapter })).resolves.toMatchObject({ claimId, status: "SUBMITTED" });
      expect(adapter.calls).toHaveLength(1);
      expect((await db.select().from(s.claims).where(eq(s.claims.id, claimId)))[0])
        .toMatchObject({ version: 2, status: "SUBMITTED" });
    });
  });

  it("retains DENIED and refuses resubmission when a corrected line overbills", async () => {
    await withDeniedClaim(async (db, claimId) => {
      const lines = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).orderBy(s.claimLines.cptCode);
      const result = await correctDeniedClaim(db, seedOrganization.id, claimId, [
        { claimLineId: lines[0]!.id, units: 3, modifiers: ["GP"] },
        { claimLineId: lines[1]!.id, units: 1, modifiers: ["GP"] },
      ]);
      expect(result).toMatchObject({ claimId, status: "DENIED", version: 1, totalUnits: 4, submissionAllowed: false });
      expect(result.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OVERBILLED_UNITS" })]));
      const adapter = new FixtureClearinghouse();
      await expect(submitScrubbedClaim(db, seedOrganization.id, claimId,
        { adapter: "fixture", clearinghouse: adapter })).rejects.toMatchObject({ code: "CLAIM_NOT_SUBMITTABLE" });
      expect(adapter.calls).toHaveLength(0);
      const claim = (await db.select().from(s.claims).where(eq(s.claims.id, claimId)))[0]!;
      expect(claim).toMatchObject({ status: "DENIED", version: 1 });
      expect(claim.snapshotJson.submission).toBeDefined();
    });
  });
});
