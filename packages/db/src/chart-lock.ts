import { and, desc, eq, lte } from "drizzle-orm";
import { lockedPtNoteToEncounterInput, LockedPtNoteSchema, type LockedPtNote } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { upsertEncounter } from "./encounter-ingest.js";
import { scrubEncounter } from "./encounter-scrub.js";
import * as s from "./schema.js";
import { seedPayers } from "./seed-data.js";

export class ChartLockError extends Error {
  constructor(readonly status: 409 | 422, readonly code: string, message: string) {
    super(message);
    this.name = "ChartLockError";
  }
}

/** Resolve fixture demographic and coverage context, then use the normal encounter ingest path. */
export async function lockPtChartNote(db: Database, organizationId: string, input: LockedPtNote) {
  const note = LockedPtNoteSchema.parse(input);
  return db.transaction(async (tx) => {
    const [patient] = await tx.select().from(s.patients).where(and(
      eq(s.patients.organizationId, organizationId), eq(s.patients.externalId, note.patientExternalId),
    ));
    if (!patient) throw new ChartLockError(422, "PATIENT_NOT_FOUND", "Synthetic patient must exist before locking a note");
    // The chart API never accepts demographic or coverage fields. It can only
    // reuse records whose fixture identifiers are already synthetic.
    if (!/^SYN(?:$|[- ])/.test(patient.firstName)) {
      throw new ChartLockError(422, "SYNTHETIC_DATA_REQUIRED", "Only synthetic fixture patients can be used");
    }
    const coverages = await tx.select().from(s.coverages).where(and(
      eq(s.coverages.patientId, patient.id), eq(s.coverages.active, true),
    ));
    if (coverages.length !== 1) {
      throw new ChartLockError(422, "COVERAGE_NOT_UNIQUE", "Exactly one active fixture coverage is required");
    }
    const coverage = coverages[0]!;
    const payerCode = coverage.payerId === seedPayers[0]!.id ? "MEDICARE"
      : coverage.payerId === seedPayers[1]!.id ? "SYN_COMMERCIAL" : null;
    if (!payerCode || !/^SYN[A-Za-z0-9-]+$/.test(coverage.memberId)) {
      throw new ChartLockError(422, "SYNTHETIC_DATA_REQUIRED", "Only synthetic fixture coverage can be used");
    }
    const externalId = `SYN-CHART-${note.externalNoteId}`;
    const [existing] = await tx.select().from(s.encounters).where(and(
      eq(s.encounters.organizationId, organizationId), eq(s.encounters.externalId, externalId),
    ));
    if (existing && existing.patientId !== patient.id) {
      throw new ChartLockError(409, "NOTE_PATIENT_MISMATCH", "A locked note cannot change patients");
    }
    const facilities = existing ? [{ id: existing.facilityId }] : await tx.select({ id: s.serviceFacilities.id })
      .from(s.serviceFacilities).where(eq(s.serviceFacilities.organizationId, organizationId));
    if (facilities.length !== 1) {
      throw new ChartLockError(422, "FACILITY_NOT_UNIQUE", "Exactly one fixture service facility is required");
    }
    const [planOfCare] = await tx.select({ signedDate: s.plansOfCare.signedDate, certifyingNpi: s.plansOfCare.certifyingNpi })
      .from(s.plansOfCare).where(and(
        eq(s.plansOfCare.patientId, patient.id), lte(s.plansOfCare.signedDate, note.dateOfService),
      )).orderBy(desc(s.plansOfCare.signedDate), s.plansOfCare.id);
    const encounter = lockedPtNoteToEncounterInput(note, {
      patient: {
        externalId: patient.externalId,
        name: { firstName: patient.firstName, lastName: patient.lastName },
        dob: patient.dob, sex: patient.sex, address: patient.address,
        coverage: { payerCode, memberId: coverage.memberId, relationship: coverage.subscriberRelationship },
      },
      facilityId: facilities[0]!.id,
      ...(planOfCare ? { planOfCare } : {}),
      ...(existing?.authorizationId ? { authorizationId: existing.authorizationId } : {}),
    });
    if (encounter.externalId !== externalId) {
      throw new Error("Chart note converter must use the reserved encounter namespace");
    }
    const stored = await upsertEncounter(tx as unknown as Database, organizationId, encounter,
      { source: "chart", lockedNote: note });
    const scrubbed = await scrubEncounter(tx as unknown as Database, organizationId, stored.encounterId);
    return { ...stored, status: scrubbed.status, claimId: scrubbed.claimId, totalUnits: scrubbed.totalUnits };
  });
}
