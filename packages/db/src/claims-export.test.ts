import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixtureClearinghouse, parseSynthetic835, renderFixture835 } from "@pt-rcm/clearinghouse";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { correctDeniedClaim, createDatabase, postRemit, readClaimExport, scrubEncounter,
  submitScrubbedClaim, upsertEncounter, type Database } from "./index.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization } from "./seed-data.js";
import * as s from "./schema.js";

const url = process.env.TEST_DATABASE_URL;
const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;
const columns = ["chargeCents", "claimId", "cptCodes", "dateOfService", "paidCents", "patientExternalId",
  "patientResponsibilityCents", "payer", "status", "units", "version"];

describe.skipIf(!url)("claim export", () => {
  let connection: ReturnType<typeof createDatabase>;
  const rollback = new Error("ROLLBACK_SYN_CLAIM_EXPORT");
  beforeAll(async () => { connection = createDatabase(url!); await seedSyntheticData(connection.db); });
  afterAll(async () => { if (connection) await connection.client.end(); });

  async function inRollback(run: (db: Database, organizationId: string) => Promise<void>) {
    try { await connection.db.transaction(async (tx) => {
      // Isolate every export assertion from concurrently seeded test fixtures.
      const organizationId = randomUUID();
      await tx.insert(s.organizations).values({ ...seedOrganization, id: organizationId });
      const db = tx as unknown as Database;
      await run(db, organizationId);
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
  }

  async function addClaim(db: Database, organizationId: string, dos: string) {
    const suffix = randomUUID();
    const input: EncounterIngestInput = { ...structuredClone(fixture), externalId: `SYN-EXPORT-${suffix}`,
      patient: { ...structuredClone(fixture.patient), externalId: `SYN-EXPORT-PAT-${suffix}` },
      facilityId: randomUUID(), dateOfService: dos,
      minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }] };
    // Providers and facilities are synthetic seed records for the organization.
    await db.insert(s.providers).values({ id: randomUUID(), organizationId, firstName: "SYN", lastName: "Export",
      npi: "0000000003", taxonomyCode: "225100000X", role: "RENDERING" }).onConflictDoNothing();
    await db.insert(s.serviceFacilities).values({ id: input.facilityId, organizationId, name: "SYN Export",
      npi: "0000000002", address: seedOrganization.address, placeOfServiceCode: "11" });
    const { encounterId } = await upsertEncounter(db, organizationId, input);
    return scrubEncounter(db, organizationId, encounterId);
  }

  it("exports exactly the allowed fields, excludes member IDs, and uses a nonrepeating cursor", async () => {
    await inRollback(async (db, org) => {
      const first = await addClaim(db, org, "2026-10-01");
      const second = await addClaim(db, org, "2026-10-02");
      expect(first.status).toBe("SCRUBBED");
      expect(second.status).toBe("SCRUBBED");
      const page1 = await readClaimExport(db, org, { limit: 1 });
      const page2 = await readClaimExport(db, org, { limit: 1, cursor: page1.nextCursor! });
      expect(page1.rows).toHaveLength(1);
      expect(page1.nextCursor).toBeTruthy();
      expect(page2.rows).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      expect(page1.rows[0]!.claimId).not.toBe(page2.rows[0]!.claimId);
      expect(page1.rows[0]!.dateOfService).toBe("2026-10-02");
      for (const row of [...page1.rows, ...page2.rows]) {
        expect(Object.keys(row).sort()).toEqual(columns);
        expect(row).toMatchObject({ units: 3, chargeCents: 13500, paidCents: 0,
          patientResponsibilityCents: 0, cptCodes: ["97110", "97530"], status: "SCRUBBED" });
      }
      const responseBody = JSON.stringify({ rows: [...page1.rows, ...page2.rows] });
      expect(responseBody).not.toContain("SYN-MEMBER-SHOULDER");
      expect(responseBody).not.toContain("address");
      expect(responseBody).not.toContain("firstName");
      expect((await readClaimExport(db, org, { status: "DENIED" })).rows).toEqual([]);
      await expect(readClaimExport(db, org, { status: "SCRUBBED", cursor: page1.nextCursor! }))
        .rejects.toMatchObject({ code: "INVALID_EXPORT_QUERY" });
      await expect(readClaimExport(db, randomUUID(), { cursor: page1.nextCursor! }))
        .rejects.toMatchObject({ code: "INVALID_EXPORT_QUERY" });
    });
  });

  it("keeps a denied submitted version beside the revised claim and matches remit amounts by version", async () => {
    await inRollback(async (db, org) => {
      const scrub = await addClaim(db, org, "2026-10-01");
      await submitScrubbedClaim(db, org, scrub.claimId,
        { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
      const doc = (await db.select({ snapshot: s.claims.snapshotJson }).from(s.claims)
        .where(eq(s.claims.id, scrub.claimId)))[0]!.snapshot.submission as { document: { lines: { cptCode: string; units: number; chargeCents: number }[] } };
      const denial = parseSynthetic835(renderFixture835({ claimId: scrub.claimId, claimVersion: 1,
        receivedOn: "2026-10-02", totalChargeCents: scrub.totalChargeCents,
        lines: doc.document.lines.map(({ cptCode, units, chargeCents }) => ({ cptCode, units, chargeCents })), outcome: "DENIED" }));
      await postRemit(db, org, denial);
      const original = (await readClaimExport(db, org)).rows[0]!;
      expect(original).toMatchObject({ version: 1, status: "DENIED", paidCents: 0, patientResponsibilityCents: 0, units: 3 });
      const lines = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, scrub.claimId));
      await correctDeniedClaim(db, org, scrub.claimId, lines.map((line) => ({ claimLineId: line.id, units: 1, modifiers: line.modifiers })));
      const page1 = await readClaimExport(db, org, { limit: 1 });
      const page2 = await readClaimExport(db, org, { limit: 1, cursor: page1.nextCursor! });
      expect(page1.rows[0]).toMatchObject({ claimId: scrub.claimId, version: 2, status: "SCRUBBED", units: 2,
        chargeCents: 9000, paidCents: 0, patientResponsibilityCents: 0 });
      expect(page2.rows[0]).toEqual(original);
      expect((await readClaimExport(db, org, { status: "DENIED" })).rows).toEqual([original]);
      expect((await readClaimExport(db, org, { status: "SCRUBBED" })).rows).toEqual(page1.rows);
    });
  });

  it("counts only matched remit amounts and filters by the current claim status", async () => {
    await inRollback(async (db, org) => {
      const scrub = await addClaim(db, org, "2026-10-01");
      await submitScrubbedClaim(db, org, scrub.claimId,
        { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
      const lines = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, scrub.claimId));
      const remit = parseSynthetic835(renderFixture835({ claimId: scrub.claimId, claimVersion: 1,
        receivedOn: "2026-10-02", totalChargeCents: scrub.totalChargeCents,
        lines: lines.map(({ cptCode, units, chargeCents }) => ({ cptCode, units, chargeCents })) }));
      await postRemit(db, org, remit);
      await db.insert(s.remits).values({ id: randomUUID(), claimId: scrub.claimId, payerIcn: "SYN-UNMATCHED",
        receivedOn: "2026-10-03", paidCents: 999, patientResponsibilityCents: 999,
        detailJson: { claimVersion: 1, result: { matched: false } } });
      const row = (await readClaimExport(db, org, { status: "PATIENT_BALANCE" })).rows[0]!;
      expect(row).toMatchObject({ claimId: scrub.claimId, status: "PATIENT_BALANCE",
        paidCents: 10800, patientResponsibilityCents: 2700, chargeCents: 13500 });
      expect((await readClaimExport(db, org, { status: "PAID" })).rows).toEqual([]);
    });
  });
});
