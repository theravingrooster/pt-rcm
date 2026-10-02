import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as d from "@pt-rcm/domain";
import { createDatabase, type Database } from "./index.js";
import * as s from "./schema.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedFacility, seedOrganization, seedPayers, seedProviders } from "./seed-data.js";

const url = process.env.TEST_DATABASE_URL;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const patientId = "10000000-0000-4000-8000-000000000001";
const encounterId = "10000000-0000-4000-8000-000000000002";
const claimId = "10000000-0000-4000-8000-000000000003";
const claimLineId = "10000000-0000-4000-8000-000000000004";
const remitId = "10000000-0000-4000-8000-000000000005";
const payerId = seedPayers[0]!.id;
const organizationId = seedOrganization.id;
const renderingProviderId = seedProviders[0]!.id;
const patient: d.Patient = {
  id: patientId, organizationId, externalId: "SYN-TEST-PATIENT", firstName: "SYN",
  lastName: "Test Patient", dob: "2000-02-29", sex: "U", address: seedOrganization.address,
};
const encounter: d.Encounter = {
  id: encounterId, organizationId, externalId: "SYN-TEST-ENCOUNTER", patientId,
  renderingProviderId, facilityId: seedFacility.id, dateOfService: "2026-10-01", status: "DRAFT",
};
const claim: d.Claim = {
  id: claimId, encounterId, version: 1, status: "DRAFT", payerId,
  totalChargeCents: 15000, snapshotJson: { source: "SYN", minutes: 15 },
};
// CPT is licensed from the AMA. This single code fixture is for local tests only.
const line: d.ClaimLine = {
  id: claimLineId, claimId, cptCode: "97110", modifiers: ["GP"], units: 1,
  chargeCents: 15000, diagnosisPointers: [0], minutes: 15,
};

// Explicit opt-in. Tests never truncate a developer database and roll back clinical fixtures.
describe.skipIf(!url)("PostgreSQL persistence", () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    connection = createDatabase(url!);
    await seedSyntheticData(connection.db);
  });
  afterAll(async () => { await connection?.client.end(); });

  const rollback = new Error("ROLLBACK_SYNTHETIC_TEST_FIXTURE");
  async function fixtureTransaction(run: (tx: Transaction) => Promise<void>) {
    await connection.db.transaction(async (tx) => {
      await tx.insert(s.patients).values(patient);
      await tx.insert(s.encounters).values(encounter);
      await tx.insert(s.claims).values(claim);
      await tx.insert(s.claimLines).values(line);
      await run(tx);
      throw rollback;
    });
  }

  async function rollbackFixture(run: (tx: Transaction) => Promise<void>) {
    try {
      await fixtureTransaction(run);
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  it("keeps the seed idempotent and adds no patients", async () => {
    const before = await connection.db.select({ count: sql<number>`count(*)::int` }).from(s.patients);
    await seedSyntheticData(connection.db);
    await seedSyntheticData(connection.db);
    const orgs = await connection.db.select().from(s.organizations).where(eq(s.organizations.id, organizationId));
    expect(orgs).toEqual([seedOrganization]);
    expect(d.OrganizationSchema.parse(orgs[0])).toEqual(seedOrganization);
    const facilities = await connection.db.select().from(s.serviceFacilities).where(eq(s.serviceFacilities.organizationId, organizationId));
    expect(facilities).toEqual([seedFacility]);
    expect(d.ServiceFacilitySchema.parse(facilities[0])).toEqual(seedFacility);
    const providers = await connection.db.select().from(s.providers).where(eq(s.providers.organizationId, organizationId));
    expect(providers).toHaveLength(2);
    providers.forEach((row) => d.ProviderSchema.parse(row));
    const payers = await connection.db.select().from(s.payers);
    expect(payers).toEqual(expect.arrayContaining(seedPayers));
    payers.forEach((row) => d.PayerSchema.parse(row));
    expect(await connection.db.select({ count: sql<number>`count(*)::int` }).from(s.patients)).toEqual(before);
  });

  it("round-trips every clinical object, arrays, JSON, dates, and UTC timestamps", async () => {
    await rollbackFixture(async (tx) => {
      expect(d.PatientSchema.parse((await tx.select().from(s.patients).where(eq(s.patients.id, patientId)))[0])).toEqual(patient);
      expect(d.EncounterSchema.parse((await tx.select().from(s.encounters).where(eq(s.encounters.id, encounterId)))[0])).toEqual(encounter);
      expect(d.ClaimSchema.parse((await tx.select().from(s.claims).where(eq(s.claims.id, claimId)))[0])).toEqual(claim);
      expect(d.ClaimLineSchema.parse((await tx.select().from(s.claimLines).where(eq(s.claimLines.id, claimLineId)))[0])).toEqual(line);
      d.CoverageSchema.parse((await tx.insert(s.coverages).values({
        patientId, payerId, memberId: "SYN-MEMBER-1", groupNumber: "SYN-GROUP",
        subscriberRelationship: "SELF", planName: "SYN Plan", active: true,
      }).returning())[0]);
      d.EncounterMinuteLineSchema.parse((await tx.insert(s.encounterMinuteLines).values({
        encounterId, cptCode: "97110", minutes: 15, timed: true, notes: null,
      }).returning())[0]);
      d.DiagnosisSchema.parse((await tx.insert(s.diagnoses).values({
        encounterId, icd10: "M25.561", pointer: 0, primary: true,
      }).returning())[0]);
      d.AuthorizationSchema.parse((await tx.insert(s.authorizations).values({
        patientId, payerId, cptFamily: "SYN-PT", visitsAuthorized: 6, visitsUsed: 7,
        startDate: "2026-01-01", endDate: "2026-12-31",
      }).returning())[0]);
      d.PlanOfCareSchema.parse((await tx.insert(s.plansOfCare).values({
        patientId, signedDate: "2026-01-01", certifyingNpi: "0000000004", expiresOn: "2026-04-01",
      }).returning())[0]);
      d.RuleSetSchema.parse((await tx.insert(s.ruleSets).values({
        version: "SYN-TEST-V1", status: "SHADOW", notes: "SYN fixture only",
      }).returning())[0]);
      // Non-UTC session proves timestamps normalize on read, including DB defaults.
      await tx.execute(sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`);
      const fire = d.RuleFireSchema.parse((await tx.insert(s.ruleFires).values({
        claimId, ruleId: "SYN-RULE", ruleVersion: "1", outcome: "FLAG", shadow: true,
        detailJson: { nested: [true, null, { minutes: 15 }] }, createdAt: "2026-10-01T12:00:00.000Z",
      }).returning())[0]);
      expect(fire.createdAt).toBe("2026-10-01T12:00:00.000Z");
      d.RemitSchema.parse((await tx.insert(s.remits).values({
        id: remitId, claimId, payerIcn: "SYN-ICN", paidCents: 12000,
        patientResponsibilityCents: 3000, receivedOn: "2026-10-02",
      }).returning())[0]);
      d.RemitLineSchema.parse((await tx.insert(s.remitLines).values({
        remitId, claimLineId, paidCents: 12000, carc: "1", rarc: null,
      }).returning())[0]);
      d.TaskSchema.parse((await tx.insert(s.tasks).values({
        claimId, kind: "SYN-REVIEW", owner: "OPERATOR", status: "OPEN", reason: "SYN test",
      }).returning())[0]);
      const audit = d.AuditEventSchema.parse((await tx.insert(s.auditEvents).values({
        actor: "SYN-TEST", action: "CREATE", entity: "Claim", entityId: claimId, detailJson: { synthetic: true },
      }).returning())[0]);
      expect(audit.at).toMatch(/Z$/);
    });
  });

  it("persists the requested Medicare HCPCS fixture in existing procedure-code fields", async () => {
    await rollbackFixture(async (tx) => {
      const [minuteLine] = await tx.insert(s.encounterMinuteLines).values({
        encounterId, cptCode: "G0283", minutes: 0, timed: false, notes: null,
      }).returning();
      expect(d.EncounterMinuteLineSchema.parse(minuteLine).cptCode).toBe("G0283");
      const [claimLine] = await tx.update(s.claimLines).set({ cptCode: "G0283", minutes: 0 })
        .where(eq(s.claimLines.id, claimLineId)).returning();
      expect(d.ClaimLineSchema.parse(claimLine).cptCode).toBe("G0283");
    });
  });

  it.each([
    ["non-synthetic organization NPI", sql`UPDATE organizations SET billing_npi = '1234567890' WHERE id = ${organizationId}`, "23514"],
    ["non-synthetic tax ID", sql`UPDATE organizations SET tax_id = '12-3456789' WHERE id = ${organizationId}`, "23514"],
    ["non-synthetic provider NPI", sql`UPDATE providers SET npi = '1234567890' WHERE id = ${renderingProviderId}`, "23514"],
    ["non-synthetic facility NPI", sql`UPDATE service_facilities SET npi = '1234567890' WHERE id = ${seedFacility.id}`, "23514"],
    ["negative cents", sql`UPDATE claims SET total_charge_cents = -1 WHERE id = ${claimId}`, "23514"],
    ["fractional cents", sql`UPDATE claims SET total_charge_cents = ${1.5} WHERE id = ${claimId}`, "22P02"],
    ["zero claim version", sql`UPDATE claims SET version = 0 WHERE id = ${claimId}`, "23514"],
    ["negative minutes", sql`UPDATE claim_lines SET minutes = -1 WHERE id = ${claimLineId}`, "23514"],
    ["negative diagnosis pointer", sql`UPDATE claim_lines SET diagnosis_pointers = ARRAY[-1] WHERE id = ${claimLineId}`, "23514"],
    ["null diagnosis pointer", sql`UPDATE claim_lines SET diagnosis_pointers = ARRAY[NULL]::integer[] WHERE id = ${claimLineId}`, "23514"],
    ["invalid modifier", sql`UPDATE claim_lines SET modifiers = ARRAY['INVALID'] WHERE id = ${claimLineId}`, "23514"],
    ["non-object snapshot", sql`UPDATE claims SET snapshot_json = '[]'::jsonb WHERE id = ${claimId}`, "23514"],
    ["orphan claim line", sql`UPDATE claim_lines SET claim_id = '99999999-0000-4000-8000-000000000000' WHERE id = ${claimLineId}`, "23503"],
  ])("rejects %s at the database boundary", async (_name, query, code) => {
    await expect(fixtureTransaction(async (tx) => {
      await tx.execute(query);
    })).rejects.toMatchObject({ code });
  });

  it("rejects duplicate claim versions", async () => {
    await expect(fixtureTransaction(async (tx) => {
      await tx.insert(s.claims).values({ ...claim, id: undefined });
    })).rejects.toMatchObject({ code: "23505" });
  });

  it("preserves distinct claim versions", async () => {
    await rollbackFixture(async (tx) => {
      await tx.insert(s.claims).values({ ...claim, id: undefined, version: 2 });
      expect(await tx.select().from(s.claims).where(eq(s.claims.encounterId, encounterId))).toHaveLength(2);
    });
  });

  it.each([
    { pointer: 0, primary: false },
    { pointer: 1, primary: true },
  ])("rejects duplicate diagnosis pointers or primary diagnoses: %j", async (duplicate) => {
    await expect(fixtureTransaction(async (tx) => {
      await tx.insert(s.diagnoses).values({ encounterId, pointer: 0, primary: true, icd10: "M25.561" });
      await tx.insert(s.diagnoses).values({ encounterId, ...duplicate, icd10: "M25.562" });
    })).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects encounter references across organizations", async () => {
    await expect(fixtureTransaction(async (tx) => {
      const otherOrgId = "20000000-0000-4000-8000-000000000001";
      await tx.insert(s.organizations).values({ ...seedOrganization, id: otherOrgId, name: "SYN Other Org" });
      await tx.update(s.encounters).set({ organizationId: otherOrgId }).where(eq(s.encounters.id, encounterId));
    })).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects non-synthetic members", async () => {
    await expect(fixtureTransaction(async (tx) => {
      await tx.insert(s.coverages).values({ patientId, payerId, memberId: "INVALID", groupNumber: "SYN-GROUP", subscriberRelationship: "SELF", planName: "SYN Plan", active: true });
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects reversed authorization dates", async () => {
    await expect(fixtureTransaction(async (tx) => {
      await tx.insert(s.authorizations).values({ patientId, payerId, cptFamily: "SYN-PT", visitsAuthorized: 1, visitsUsed: 0, startDate: "2026-10-01", endDate: "2026-09-01" });
    })).rejects.toMatchObject({ code: "23514" });
  });
});
