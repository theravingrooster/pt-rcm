import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { type ClaimStatus, type EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, upsertEncounter } from "./index.js";
import * as s from "./schema.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedFacility, seedOrganization, seedPayers, seedProviders } from "./seed-data.js";

const url = process.env.TEST_DATABASE_URL;
const example = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const facilityId = randomUUID();
const otherFacilityId = randomUUID();
const payerId = seedPayers[0]!.id;
function input(): EncounterIngestInput {
  return { ...structuredClone(example), externalId: `SYN-ENC-${randomUUID()}`, facilityId,
    patient: { ...structuredClone(example.patient), externalId: `SYN-PAT-${randomUUID()}` } };
}

// Explicit test-database opt-in; delete only this run's randomly scoped fixtures.
describe.skipIf(!url)("transactional encounter ingestion", () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    connection = createDatabase(url!);
    await seedSyntheticData(connection.db);
    for (const [id, facility] of [[organizationId, facilityId], [otherOrganizationId, otherFacilityId]] as const) {
      await connection.db.insert(s.organizations).values({ ...seedOrganization, id, name: "SYN Ingest Test" });
      await connection.db.insert(s.serviceFacilities).values({ ...seedFacility, id: facility, organizationId: id });
      await connection.db.insert(s.providers).values({ ...seedProviders[0]!, id: randomUUID(), organizationId: id });
    }
  });
  afterAll(async () => {
    if (!connection) return;
    try {
      await connection.db.transaction(async (tx) => {
        const orgIds = [organizationId, otherOrganizationId];
        const encounters = await tx.select({ id: s.encounters.id }).from(s.encounters).where(inArray(s.encounters.organizationId, orgIds));
        const encounterIds = encounters.map((row) => row.id);
        if (encounterIds.length) {
          await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, encounterIds));
          await tx.delete(s.claims).where(inArray(s.claims.encounterId, encounterIds));
          await tx.delete(s.encounterMinuteLines).where(inArray(s.encounterMinuteLines.encounterId, encounterIds));
          await tx.delete(s.diagnoses).where(inArray(s.diagnoses.encounterId, encounterIds));
          await tx.delete(s.encounters).where(inArray(s.encounters.id, encounterIds));
        }
        const patients = await tx.select({ id: s.patients.id }).from(s.patients).where(inArray(s.patients.organizationId, orgIds));
        const patientIds = patients.map((row) => row.id);
        if (patientIds.length) {
          await tx.delete(s.plansOfCare).where(inArray(s.plansOfCare.patientId, patientIds));
          await tx.delete(s.authorizations).where(inArray(s.authorizations.patientId, patientIds));
          await tx.delete(s.coverages).where(inArray(s.coverages.patientId, patientIds));
          await tx.delete(s.patients).where(inArray(s.patients.id, patientIds));
        }
        await tx.delete(s.providers).where(inArray(s.providers.organizationId, orgIds));
        await tx.delete(s.serviceFacilities).where(inArray(s.serviceFacilities.organizationId, orgIds));
        await tx.delete(s.organizations).where(inArray(s.organizations.id, orgIds));
      });
    } finally { await connection.client.end(); }
  });

  async function persisted(encounterId: string) {
    const [encounter] = await connection.db.select().from(s.encounters).where(eq(s.encounters.id, encounterId));
    const lines = await connection.db.select().from(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, encounterId));
    const diagnoses = await connection.db.select().from(s.diagnoses).where(eq(s.diagnoses.encounterId, encounterId)).orderBy(s.diagnoses.pointer);
    const audits = await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, encounterId)).orderBy(s.auditEvents.at);
    return { encounter, lines, diagnoses, audits };
  }

  it("creates a draft, patient, coverage, plan, lines, diagnoses, and audit with no claims", async () => {
    const body = input();
    const result = await upsertEncounter(connection.db, organizationId, body);
    expect(result).toMatchObject({ created: true, status: "DRAFT" });
    const saved = await persisted(result.encounterId);
    expect(saved.encounter).toMatchObject({ organizationId, externalId: body.externalId, status: "DRAFT", authorizationId: null });
    expect(saved.lines.map(({ cptCode, minutes, timed }) => ({ cptCode, minutes, timed }))).toEqual(expect.arrayContaining([
      { cptCode: "97110", minutes: 15, timed: true }, { cptCode: "97140", minutes: 8, timed: true },
    ]));
    expect(saved.lines).toHaveLength(2);
    expect(saved.diagnoses).toMatchObject([{ icd10: "M25.511", pointer: 0, primary: true }]);
    expect(saved.audits).toMatchObject([{ action: "ENCOUNTER_UPSERTED", entity: "Encounter", detailJson: { created: true } }]);
    expect(saved.audits[0]!.at).toMatch(/Z$/);
    expect(await connection.db.select().from(s.coverages).where(eq(s.coverages.patientId, result.patientId)))
      .toMatchObject([{ payerId, memberId: body.patient.coverage.memberId, groupNumber: null, planName: null }]);
    expect(await connection.db.select().from(s.plansOfCare).where(eq(s.plansOfCare.patientId, result.patientId)))
      .toMatchObject([{ ...body.planOfCare, expiresOn: null }]);
    expect(await connection.db.select().from(s.claims).where(eq(s.claims.encounterId, result.encounterId))).toEqual([]);
  });

  it.each(["DRAFT", "HELD"] as const)("updates a %s encounter idempotently and resets it to DRAFT", async (status) => {
    const body = input();
    const first = await upsertEncounter(connection.db, organizationId, body);
    await connection.db.update(s.encounters).set({ status }).where(eq(s.encounters.id, first.encounterId));
    await connection.db.update(s.coverages).set({ groupNumber: "SYN-GROUP", planName: "SYN Existing Plan",
      eligible: true, checkedAt: "2026-10-02T12:00:00.000Z", deductibleRemainingCents: 1500, planActive: true,
    }).where(eq(s.coverages.patientId, first.patientId));
    await connection.db.update(s.plansOfCare).set({ expiresOn: "2026-12-31" }).where(eq(s.plansOfCare.patientId, first.patientId));
    body.patient.name = "SYN Updated Demo";
    body.patient.coverage.memberId = "SYN-MEMBER-UPDATED";
    body.minuteLines = [{ cptCode: "97112", minutes: 23 }, { cptCode: "G0283", minutes: 0 }];
    body.diagnoses = ["M25.512", "M25.511"];
    const second = await upsertEncounter(connection.db, organizationId, body);
    expect(second).toEqual({ ...first, created: false });
    const saved = await persisted(first.encounterId);
    expect(saved.encounter!.status).toBe("DRAFT");
    expect(saved.lines).toHaveLength(2);
    expect(saved.lines).toEqual(expect.arrayContaining([expect.objectContaining({ cptCode: "G0283", minutes: 0, timed: false })]));
    expect(saved.diagnoses).toMatchObject([{ icd10: "M25.512", pointer: 0, primary: true }, { icd10: "M25.511", pointer: 1, primary: false }]);
    expect(saved.audits).toHaveLength(2);
    expect(await connection.db.select().from(s.patients).where(and(eq(s.patients.organizationId, organizationId), eq(s.patients.externalId, body.patient.externalId))))
      .toMatchObject([{ id: first.patientId, firstName: "SYN", lastName: "Updated Demo" }]);
    expect(await connection.db.select().from(s.coverages).where(eq(s.coverages.patientId, first.patientId)))
      .toMatchObject([{ memberId: "SYN-MEMBER-UPDATED", groupNumber: "SYN-GROUP", planName: "SYN Existing Plan",
        eligible: null, checkedAt: null, deductibleRemainingCents: null, planActive: null }]);
    expect(await connection.db.select().from(s.plansOfCare).where(eq(s.plansOfCare.patientId, first.patientId)))
      .toMatchObject([{ expiresOn: "2026-12-31" }]);
  });

  it("preserves a cached check when a repeat ingest keeps the same member ID", async () => {
    const body = input();
    const first = await upsertEncounter(connection.db, organizationId, body);
    await connection.db.update(s.coverages).set({ eligible: true, checkedAt: "2026-10-02T12:00:00.000Z",
      deductibleRemainingCents: 1500, planActive: true }).where(eq(s.coverages.patientId, first.patientId));
    await upsertEncounter(connection.db, organizationId, body);
    expect(await connection.db.select().from(s.coverages).where(eq(s.coverages.patientId, first.patientId)))
      .toMatchObject([{ eligible: true, checkedAt: "2026-10-02T12:00:00.000Z",
        deductibleRemainingCents: 1500, planActive: true }]);
  });

  it.each<ClaimStatus>(["SUBMITTED", "ACCEPTED", "REJECTED", "PAID", "DENIED", "PATIENT_BALANCE"])("rejects updates after claim status %s, including a later draft version", async (status) => {
    const body = input();
    const first = await upsertEncounter(connection.db, organizationId, body);
    // Synthetic state setup only. Nothing is sent to a clearinghouse.
    await connection.db.insert(s.claims).values([
      { encounterId: first.encounterId, payerId, version: 1, status, totalChargeCents: 0, snapshotJson: {} },
      { encounterId: first.encounterId, payerId, version: 2, status: "DRAFT", totalChargeCents: 0, snapshotJson: {} },
    ]);
    const before = await persisted(first.encounterId);
    body.patient.externalId = `SYN-REJECTED-${randomUUID()}`;
    await expect(upsertEncounter(connection.db, organizationId, body)).rejects.toMatchObject({ status: 409, code: "CLAIM_ALREADY_SUBMITTED" });
    expect(await persisted(first.encounterId)).toEqual(before);
    expect(await connection.db.select().from(s.patients).where(eq(s.patients.externalId, body.patient.externalId))).toEqual([]);
  });

  it.each(["READY", "CLAIMED"] as const)("does not replace an encounter in status %s", async (status) => {
    const body = input();
    const first = await upsertEncounter(connection.db, organizationId, body);
    await connection.db.update(s.encounters).set({ status }).where(eq(s.encounters.id, first.encounterId));
    await expect(upsertEncounter(connection.db, organizationId, body)).rejects.toMatchObject({ status: 409, code: "ENCOUNTER_NOT_EDITABLE" });
  });

  it("rejects unknown CPT without writing a patient or encounter", async () => {
    const body = input();
    body.minuteLines = [{ cptCode: "99999", minutes: 23 }];
    await expect(upsertEncounter(connection.db, organizationId, body)).rejects.toMatchObject({ name: "ZodError" });
    expect(await connection.db.select().from(s.patients).where(eq(s.patients.externalId, body.patient.externalId))).toEqual([]);
    expect(await connection.db.select().from(s.encounters).where(eq(s.encounters.externalId, body.externalId))).toEqual([]);
  });

  it("rejects cross-organization facilities and missing rendering providers", async () => {
    const body = input();
    await expect(upsertEncounter(connection.db, organizationId, { ...body, facilityId: otherFacilityId })).rejects.toMatchObject({ status: 422 });
    await expect(upsertEncounter(connection.db, organizationId, { ...body, renderingProviderNpi: "0009999999" })).rejects.toMatchObject({ status: 422 });
    expect(await connection.db.select().from(s.patients).where(eq(s.patients.externalId, body.patient.externalId))).toEqual([]);
  });

  it("keeps identical external IDs isolated by organization", async () => {
    const body = input();
    const first = await upsertEncounter(connection.db, organizationId, body);
    const other = await upsertEncounter(connection.db, otherOrganizationId, { ...body, facilityId: otherFacilityId });
    expect(other.created).toBe(true);
    expect(other.encounterId).not.toBe(first.encounterId);
    expect(other.patientId).not.toBe(first.patientId);
  });

  it("serializes concurrent duplicate requests without duplicate patients, coverage, or plans", async () => {
    const body = input();
    const results = await Promise.all([upsertEncounter(connection.db, organizationId, body), upsertEncounter(connection.db, organizationId, body)]);
    expect(results.map((row) => row.created).sort()).toEqual([false, true]);
    expect(results[0]!.encounterId).toBe(results[1]!.encounterId);
    expect(results[0]!.patientId).toBe(results[1]!.patientId);
    expect((await persisted(results[0]!.encounterId)).audits).toHaveLength(2);
    expect(await connection.db.select().from(s.coverages).where(eq(s.coverages.patientId, results[0]!.patientId))).toHaveLength(1);
    expect(await connection.db.select().from(s.plansOfCare).where(eq(s.plansOfCare.patientId, results[0]!.patientId))).toHaveLength(1);
  });

  it("links an authorization without running expiry or utilization rules; rejects mismatched ownership atomically", async () => {
    const body = input();
    const first = await upsertEncounter(connection.db, organizationId, body);
    const [authorization] = await connection.db.insert(s.authorizations).values({
      patientId: first.patientId, payerId, cptFamily: "SYN-PT", visitsAuthorized: 1, visitsUsed: 2,
      startDate: "2025-01-01", endDate: "2025-12-31",
    }).returning();
    body.authorizationId = authorization!.id;
    await upsertEncounter(connection.db, organizationId, body);
    expect((await persisted(first.encounterId)).encounter!.authorizationId).toBe(authorization!.id);
    const other = input();
    other.authorizationId = authorization!.id;
    await expect(upsertEncounter(connection.db, organizationId, other)).rejects.toMatchObject({ status: 422, code: "AUTHORIZATION_NOT_FOUND" });
    expect(await connection.db.select().from(s.patients).where(eq(s.patients.externalId, other.patient.externalId))).toEqual([]);
    body.patient.coverage.payerCode = "SYN_COMMERCIAL";
    await expect(upsertEncounter(connection.db, organizationId, body)).rejects.toMatchObject({ status: 422 });
    expect(await connection.db.select().from(s.coverages).where(eq(s.coverages.patientId, first.patientId))).toHaveLength(1);
    delete body.authorizationId;
    await upsertEncounter(connection.db, organizationId, body);
    expect((await persisted(first.encounterId)).encounter!.authorizationId).toBeNull();
    expect(await connection.db.select().from(s.coverages).where(eq(s.coverages.patientId, first.patientId)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ payerId: seedPayers[1]!.id })]));
  });
});
