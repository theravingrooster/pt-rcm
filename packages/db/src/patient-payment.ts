import { and, desc, eq, sql } from "drizzle-orm";
import { IdSchema } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { persistClaimTransition } from "./claim-lifecycle.js";
import * as s from "./schema.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Claim = typeof s.claims.$inferSelect;

export class PatientPaymentError extends Error {
  constructor(readonly status: 404 | 409 | 422, readonly code: string, message: string) {
    super(message);
    this.name = "PatientPaymentError";
  }
}

/** A receipt is tied to the claim's current submitted version. A previous
 * denial's remit remains in the ledger after correction, but is not an invoice.
 */
async function invoiceForClaim(tx: Transaction, claim: Claim) {
  if (claim.status !== "PATIENT_BALANCE" && claim.status !== "PAID") return null;
  const receipts = await tx.select().from(s.remits).where(eq(s.remits.claimId, claim.id))
    .orderBy(desc(s.remits.receivedOn), desc(s.remits.id));
  const receipt = receipts.find((row) => row.detailJson.claimVersion === claim.version
    && typeof row.detailJson.result === "object" && row.detailJson.result !== null
    && !Array.isArray(row.detailJson.result) && row.detailJson.result.status === "PATIENT_BALANCE");
  if (!receipt) return null;
  const posted = await tx.select({ remitLine: s.remitLines, claimLine: s.claimLines })
    .from(s.remitLines).innerJoin(s.claimLines, eq(s.claimLines.id, s.remitLines.claimLineId))
    .where(eq(s.remitLines.remitId, receipt.id))
    .orderBy(s.claimLines.cptCode, s.claimLines.id);
  const expected = await tx.select({ id: s.claimLines.id }).from(s.claimLines).where(eq(s.claimLines.claimId, claim.id));
  if (posted.length !== expected.length || posted.length === 0
    || posted.some(({ claimLine }) => claimLine.claimId !== claim.id)
    || new Set(posted.map(({ claimLine }) => claimLine.id)).size !== expected.length) {
    throw new PatientPaymentError(409, "INVOICE_DATA_INCOMPLETE", "Posted remit lines do not match the claim lines");
  }
  const lines = posted.map(({ claimLine, remitLine }) => ({ claimLineId: claimLine.id, cptCode: claimLine.cptCode,
    modifiers: claimLine.modifiers, units: claimLine.units, chargeCents: claimLine.chargeCents,
    payerPaidCents: remitLine.paidCents, patientOwedCents: remitLine.patientResponsibilityCents }));
  const payments = await tx.select({ id: s.patientPayments.id, amountCents: s.patientPayments.amountCents,
    recordedAt: s.patientPayments.recordedAt }).from(s.patientPayments).where(eq(s.patientPayments.claimId, claim.id))
    .orderBy(s.patientPayments.recordedAt, s.patientPayments.id);
  const patientOwedCents = lines.reduce((total, line) => total + line.patientOwedCents, 0);
  const paidByPatientCents = payments.reduce((total, payment) => total + payment.amountCents, 0);
  if (patientOwedCents < 1 || paidByPatientCents > patientOwedCents) {
    throw new PatientPaymentError(409, "INVOICE_DATA_INCONSISTENT", "Patient responsibility and receipts are inconsistent");
  }
  return { claimId: claim.id, status: claim.status, lines,
    chargeCents: lines.reduce((total, line) => total + line.chargeCents, 0),
    payerPaidCents: lines.reduce((total, line) => total + line.payerPaidCents, 0),
    patientOwedCents, paidByPatientCents, remainingCents: patientOwedCents - paidByPatientCents, payments };
}

/** A read-only, organization-scoped model for a printable patient invoice. */
export async function readPatientInvoice(db: Database, organizationId: string, claimId: string) {
  IdSchema.parse(organizationId); IdSchema.parse(claimId);
  return db.transaction(async (tx) => {
    const [claim] = await tx.select({ claim: s.claims }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.claims.id, claimId), eq(s.encounters.organizationId, organizationId)));
    if (!claim) throw new PatientPaymentError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    return invoiceForClaim(tx, claim.claim);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export type PatientInvoice = NonNullable<Awaited<ReturnType<typeof readPatientInvoice>>>;

/** Synthetic cash ledger. Locking the encounter then claim follows the other
 * claim writers; a stable receipt ID makes a retried request idempotent.
 */
export async function recordPatientPayment(db: Database, organizationId: string, claimId: string,
  paymentId: string, amountCents: number) {
  IdSchema.parse(organizationId); IdSchema.parse(claimId); IdSchema.parse(paymentId);
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 2_147_483_647) {
    throw new PatientPaymentError(422, "INVALID_PAYMENT_AMOUNT", "Payment must be a positive integer number of cents");
  }
  return db.transaction(async (tx) => {
    const [reference] = await tx.select({ encounterId: s.claims.encounterId }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.claims.id, claimId), eq(s.encounters.organizationId, organizationId)));
    if (!reference) throw new PatientPaymentError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    await tx.select({ id: s.encounters.id }).from(s.encounters).where(eq(s.encounters.id, reference.encounterId)).for("update");
    const siblings = await tx.select().from(s.claims).where(eq(s.claims.encounterId, reference.encounterId))
      .orderBy(desc(s.claims.version)).for("update");
    const claim = siblings.find((row) => row.id === claimId)!;
    if (siblings[0]!.id !== claimId) throw new PatientPaymentError(409, "CLAIM_SUPERSEDED", "Only the latest claim version can receive payments");
    const invoice = await invoiceForClaim(tx, claim);
    // Payment IDs are globally unique. Coordinate duplicates across different
    // claims before checking the current balance or inserting the receipt.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`patient-payment:${paymentId}`}, 0))`);
    const [existing] = await tx.select().from(s.patientPayments).where(eq(s.patientPayments.id, paymentId));
    if (existing) {
      if (existing.claimId !== claimId || existing.amountCents !== amountCents) {
        throw new PatientPaymentError(409, "PAYMENT_ID_CONFLICT", "This payment ID already identifies another receipt");
      }
      if (!invoice) throw new PatientPaymentError(409, "INVOICE_UNAVAILABLE", "This claim has no patient invoice");
      return { claimId, paymentId, amountCents, remainingCents: invoice.remainingCents,
        status: invoice.status as "PATIENT_BALANCE" | "PAID", duplicate: true };
    }
    if (claim.status !== "PATIENT_BALANCE" || !invoice) {
      throw new PatientPaymentError(409, "CLAIM_NOT_PAYABLE", "Only a claim with a posted patient balance can receive a patient payment");
    }
    if (amountCents > invoice.remainingCents) {
      throw new PatientPaymentError(422, "PAYMENT_EXCEEDS_BALANCE", "Patient payment exceeds the remaining balance");
    }
    await tx.insert(s.patientPayments).values({ id: paymentId, claimId, amountCents });
    const remainingCents = invoice.remainingCents - amountCents;
    const status = remainingCents === 0 ? (await persistClaimTransition(tx, claim, "PAID")).status : claim.status;
    await tx.insert(s.auditEvents).values({ actor: "SYN-OPERATOR", action: "PATIENT_PAYMENT", entity: "Claim", entityId: claimId,
      at: new Date().toISOString(), detailJson: { paymentId, amountCents, remainingCents, from: claim.status, to: status } });
    return { claimId, paymentId, amountCents, remainingCents, status: status as "PATIENT_BALANCE" | "PAID", duplicate: false };
  });
}
