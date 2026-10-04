import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, getClaimDocumentFor837, scrubEncounter, submitScrubbedClaim, upsertEncounter,
  type Database } from "./index.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization } from "./seed-data.js";
import * as s from "./schema.js";

const url = process.env.TEST_DATABASE_URL;
const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;

describe.skipIf(!url)("synthetic 837 document read", () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(async () => { connection = createDatabase(url!); await seedSyntheticData(connection.db); });
  afterAll(async () => { if (connection) await connection.client.end(); });

  const rollback = new Error("ROLLBACK_SYN_837_READ");
  async function withClaim(run: (db: Database, claimId: string, encounterId: string) => Promise<void>) {
    try {
      await connection.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        const input: EncounterIngestInput = { ...structuredClone(fixture),
          externalId: `SYN-837-${randomUUID()}`,
          patient: { ...structuredClone(fixture.patient), externalId: `SYN-837-PAT-${randomUUID()}` },
          minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }] };
        const { encounterId } = await upsertEncounter(db, seedOrganization.id, input);
        const scrubbed = await scrubEncounter(db, seedOrganization.id, encounterId);
        expect(scrubbed).toMatchObject({ status: "SCRUBBED", totalUnits: 3 });
        await run(db, scrubbed.claimId, encounterId);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
  }

  it("rejects a blocked claim before any synthetic text is generated", async () => {
    await withClaim(async (db, claimId, encounterId) => {
      const [line] = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId));
      await db.update(s.claimLines).set({ units: 3 }).where(eq(s.claimLines.id, line!.id));
      const blocked = await scrubEncounter(db, seedOrganization.id, encounterId);
      expect(blocked).toMatchObject({ status: "BLOCKED", totalUnits: 4 });
      await expect(getClaimDocumentFor837(db, seedOrganization.id, claimId))
        .rejects.toMatchObject({ code: "CLAIM_NOT_SUBMITTABLE", status: "BLOCKED" });
    });
  });

  it("returns the exact saved submission document after the claim leaves SCRUBBED", async () => {
    await withClaim(async (db, claimId) => {
      await submitScrubbedClaim(db, seedOrganization.id, claimId,
        { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
      const original = await getClaimDocumentFor837(db, seedOrganization.id, claimId);
      expect(original.lines.map(({ units }) => units)).toEqual([2, 1]);
      expect(original.lines.map(({ modifiers }) => modifiers)).toEqual([["GP"], ["GP"]]);
      const [line] = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId));
      await db.update(s.claimLines).set({ units: 4 }).where(eq(s.claimLines.id, line!.id));
      expect(await getClaimDocumentFor837(db, seedOrganization.id, claimId)).toEqual(original);
    });
  });

  it("rejects a saved submission whose claim version does not match", async () => {
    await withClaim(async (db, claimId) => {
      await submitScrubbedClaim(db, seedOrganization.id, claimId,
        { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
      const [claim] = await db.select().from(s.claims).where(eq(s.claims.id, claimId));
      const submission = claim!.snapshotJson.submission as Record<string, unknown>;
      const document = submission.document as Record<string, unknown>;
      await db.update(s.claims).set({ snapshotJson: {
        ...claim!.snapshotJson,
        submission: { ...submission, document: { ...document, claimVersion: claim!.version + 1 } },
      } }).where(eq(s.claims.id, claimId));
      await expect(getClaimDocumentFor837(db, seedOrganization.id, claimId))
        .rejects.toMatchObject({ status: 422, code: "SUBMISSION_DOCUMENT_UNAVAILABLE" });
    });
  });
});
