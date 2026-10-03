import { and, desc, eq } from "drizzle-orm";
import { IdSchema } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";

const readOnly = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/** Organization-scoped patient roster with its saved coverage and eligibility cache. */
export async function listOperatorPatients(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  const rows = await db.select({ patient: s.patients, coverage: s.coverages, payer: s.payers })
    .from(s.patients)
    .leftJoin(s.coverages, eq(s.coverages.patientId, s.patients.id))
    .leftJoin(s.payers, eq(s.payers.id, s.coverages.payerId))
    .where(eq(s.patients.organizationId, organizationId))
    .orderBy(s.patients.lastName, s.patients.firstName, s.patients.id, s.payers.name);
  const roster = new Map<string, { patient: typeof s.patients.$inferSelect; coverages: { coverage: typeof s.coverages.$inferSelect; payer: typeof s.payers.$inferSelect }[] }>();
  for (const { patient, coverage, payer } of rows) {
    let entry = roster.get(patient.id);
    if (!entry) {
      entry = { patient, coverages: [] };
      roster.set(patient.id, entry);
    }
    if (coverage && payer) entry.coverages.push({ coverage, payer });
  }
  return [...roster.values()];
}

export async function getOperatorPatient(db: Database, organizationId: string, patientId: string) {
  IdSchema.parse(organizationId);
  IdSchema.parse(patientId);
  return db.transaction(async (tx) => {
    const [patient] = await tx.select().from(s.patients).where(and(
      eq(s.patients.id, patientId), eq(s.patients.organizationId, organizationId)));
    if (!patient) return null;
    const [coverages, encounters] = await Promise.all([
      tx.select({ coverage: s.coverages, payer: s.payers }).from(s.coverages)
        .innerJoin(s.payers, eq(s.payers.id, s.coverages.payerId))
        .where(eq(s.coverages.patientId, patientId)).orderBy(s.payers.name, s.coverages.id),
      tx.select().from(s.encounters).where(and(
        eq(s.encounters.patientId, patientId), eq(s.encounters.organizationId, organizationId)))
        .orderBy(desc(s.encounters.dateOfService), s.encounters.id),
    ]);
    return { patient, coverages, encounters };
  }, readOnly);
}

/** Posted remit records. Claim joins keep even unmatched fixture receipts visible. */
export async function listOperatorRemits(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  return db.select({ remit: s.remits, claim: s.claims, encounter: s.encounters, patient: s.patients, payer: s.payers })
    .from(s.remits)
    .innerJoin(s.claims, eq(s.claims.id, s.remits.claimId))
    .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
    .innerJoin(s.patients, eq(s.patients.id, s.encounters.patientId))
    .innerJoin(s.payers, eq(s.payers.id, s.claims.payerId))
    .where(eq(s.encounters.organizationId, organizationId))
    .orderBy(desc(s.remits.receivedOn), desc(s.remits.id));
}
