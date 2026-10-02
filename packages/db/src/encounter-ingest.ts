import { and, eq, sql } from "drizzle-orm";
import { EncounterIngestSchema, IdSchema, getCptFixture, type EncounterIngestResult } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";
import { seedOrganization, seedPayers } from "./seed-data.js";

export const DEFAULT_INGEST_ORGANIZATION_ID = seedOrganization.id;
const payerIds = {
  MEDICARE: seedPayers[0]!.id,
  SYN_COMMERCIAL: seedPayers[1]!.id,
};

export class EncounterIngestError extends Error {
  constructor(readonly status: 409 | 422, readonly code: string, message: string) {
    super(message);
    this.name = "EncounterIngestError";
  }
}

/** Persist recorded inputs only. No billing rules, allocation, or clearinghouse calls. */
export async function upsertEncounter(db: Database, organizationId: string, input: unknown): Promise<EncounterIngestResult> {
  IdSchema.parse(organizationId);
  const data = EncounterIngestSchema.parse(input);
  return db.transaction(async (tx) => {
    // Serialize even the first insert for an organization/external ID pair.
    // Hash collisions only serialize unrelated requests; the unique key is authoritative.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([organizationId, data.externalId])}, 0))`);
    const [existing] = await tx.select().from(s.encounters).where(and(
      eq(s.encounters.organizationId, organizationId), eq(s.encounters.externalId, data.externalId),
    )).for("update");
    if (existing) {
      // Lock claim rows as well as the encounter so a concurrent status transition
      // cannot slip between the submission check and the draft replacement.
      const claims = await tx.select({ status: s.claims.status }).from(s.claims)
        .where(eq(s.claims.encounterId, existing.id)).for("update");
      const preSubmission = new Set(["DRAFT", "SCRUBBED", "BLOCKED", "SHADOWED"]);
      if (claims.some((claim) => !preSubmission.has(claim.status))) {
        throw new EncounterIngestError(409, "CLAIM_ALREADY_SUBMITTED", "A submitted claim prevents encounter updates");
      }
      if (existing.status !== "DRAFT" && existing.status !== "HELD") {
        throw new EncounterIngestError(409, "ENCOUNTER_NOT_EDITABLE", "Only DRAFT or HELD encounters can be updated");
      }
    }

    const [facility] = await tx.select({ id: s.serviceFacilities.id }).from(s.serviceFacilities).where(and(
      eq(s.serviceFacilities.id, data.facilityId), eq(s.serviceFacilities.organizationId, organizationId),
    ));
    const [provider] = await tx.select({ id: s.providers.id }).from(s.providers).where(and(
      eq(s.providers.organizationId, organizationId), eq(s.providers.npi, data.renderingProviderNpi), eq(s.providers.role, "RENDERING"),
    ));
    const payerId = payerIds[data.patient.coverage.payerCode];
    const [payer] = await tx.select({ id: s.payers.id }).from(s.payers).where(eq(s.payers.id, payerId));
    if (!facility || !provider || !payer) {
      throw new EncounterIngestError(422, "REFERENCE_NOT_FOUND", "Facility, rendering provider, or fixture payer is unavailable for this organization");
    }

    const patientValues = {
      organizationId, externalId: data.patient.externalId,
      firstName: data.patient.name.firstName, lastName: data.patient.name.lastName,
      dob: data.patient.dob, sex: data.patient.sex, address: data.patient.address,
    };
    // This upsert also holds the patient row lock, serializing coverage and POC
    // writes when different encounters for the same patient arrive together.
    const [patient] = await tx.insert(s.patients).values(patientValues).onConflictDoUpdate({
      target: [s.patients.organizationId, s.patients.externalId], set: patientValues,
    }).returning();
    if (!patient) throw new Error("Patient upsert returned no row");

    if (data.authorizationId) {
      const [authorization] = await tx.select({ id: s.authorizations.id }).from(s.authorizations).where(and(
        eq(s.authorizations.id, data.authorizationId), eq(s.authorizations.patientId, patient.id), eq(s.authorizations.payerId, payerId),
      ));
      if (!authorization) throw new EncounterIngestError(422, "AUTHORIZATION_NOT_FOUND", "Authorization must belong to this patient and payer");
    }
    const coverageValues = {
      memberId: data.patient.coverage.memberId,
      subscriberRelationship: data.patient.coverage.relationship, active: true,
    };
    await tx.insert(s.coverages).values({
      patientId: patient.id, payerId, ...coverageValues, groupNumber: null, planName: null,
    }).onConflictDoUpdate({ target: [s.coverages.patientId, s.coverages.payerId], set: coverageValues });

    if (data.planOfCare) {
      const [plan] = await tx.select({ id: s.plansOfCare.id }).from(s.plansOfCare).where(and(
        eq(s.plansOfCare.patientId, patient.id), eq(s.plansOfCare.signedDate, data.planOfCare.signedDate),
        eq(s.plansOfCare.certifyingNpi, data.planOfCare.certifyingNpi),
      ));
      if (!plan) await tx.insert(s.plansOfCare).values({ patientId: patient.id, ...data.planOfCare, expiresOn: null });
    }

    const values = {
      organizationId, externalId: data.externalId, patientId: patient.id,
      renderingProviderId: provider.id, facilityId: facility.id, dateOfService: data.dateOfService,
      status: "DRAFT" as const, authorizationId: data.authorizationId ?? null,
    };
    const [encounter] = existing
      ? await tx.update(s.encounters).set(values).where(eq(s.encounters.id, existing.id)).returning()
      : await tx.insert(s.encounters).values(values).returning();
    if (!encounter) throw new Error("Encounter upsert returned no row");
    await tx.delete(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, encounter.id));
    await tx.delete(s.diagnoses).where(eq(s.diagnoses.encounterId, encounter.id));
    if (data.minuteLines.length) await tx.insert(s.encounterMinuteLines).values(data.minuteLines.map((line) => ({
      ...line, encounterId: encounter.id, timed: getCptFixture(line.cptCode)!.timed, notes: null,
    })));
    if (data.diagnoses.length) await tx.insert(s.diagnoses).values(data.diagnoses.map((icd10, pointer) => ({
      encounterId: encounter.id, icd10, pointer, primary: pointer === 0,
    })));
    await tx.insert(s.auditEvents).values({
      actor: "SYN-INGEST", action: "ENCOUNTER_UPSERTED", entity: "Encounter", entityId: encounter.id,
      detailJson: { created: !existing, patientId: patient.id, minuteLineCount: data.minuteLines.length, diagnosisCount: data.diagnoses.length },
    });
    return { encounterId: encounter.id, patientId: patient.id, status: "DRAFT", created: !existing };
  });
}
