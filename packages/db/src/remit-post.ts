import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { applyRemit, IdSchema, JsonObjectSchema, RemitEnvelopeSchema, RemitPostingResultSchema,
  type RemitEnvelope, type RemitPostingResult } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { persistClaimTransition } from "./claim-lifecycle.js";
import { openClaimTask } from "./tasks.js";
import * as s from "./schema.js";

export class RemitPostingError extends Error {
  constructor(readonly status: 404 | 409 | 422 | 503, readonly code: string, message: string) {
    super(message); this.name = "RemitPostingError";
  }
}

/** One receipt, its lines, lifecycle edges, tasks, and visit release are atomic.
 * A repeated ID returns the stored result before attempting terminal transitions.
 */
export async function postRemit(db: Database, organizationId: string, remitEnvelope: RemitEnvelope, source: "recorded" | "fixture" = "recorded"): Promise<RemitPostingResult> {
  IdSchema.parse(organizationId);
  const envelope = RemitEnvelopeSchema.parse(remitEnvelope);
  return db.transaction(async (tx) => {
    const [reference] = await tx.select({ encounterId: s.claims.encounterId }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.claims.id, envelope.claimId), eq(s.encounters.organizationId, organizationId)));
    if (!reference) throw new RemitPostingError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    const [encounter] = await tx.select().from(s.encounters).where(eq(s.encounters.id, reference.encounterId)).for("update");
    const siblings = await tx.select().from(s.claims).where(eq(s.claims.encounterId, reference.encounterId)).orderBy(desc(s.claims.version)).for("update");
    const claim = siblings.find((row) => row.id === envelope.claimId)!;
    // Covers even an erroneous reused ID arriving concurrently for two claims.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`remit:${envelope.id}`}, 0))`);
    const [existing] = await tx.select().from(s.remits).where(eq(s.remits.id, envelope.id));
    if (existing) {
      if (existing.claimId !== claim.id || !isDeepStrictEqual(existing.detailJson.envelope, envelope)) {
        throw new RemitPostingError(409, "REMIT_ID_CONFLICT", "This remit ID already identifies a different receipt");
      }
      return { ...RemitPostingResultSchema.parse(existing.detailJson.result), duplicate: true, authorizationVisitDecremented: false };
    }
    if (siblings[0]!.id !== claim.id) throw new RemitPostingError(409, "CLAIM_SUPERSEDED", "A new remit cannot be applied to a superseded claim");
    const lines = await tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, claim.id)).orderBy(s.claimLines.cptCode, s.claimLines.id).for("update");
    const application = applyRemit({ ...claim, lines }, envelope);
    let next = claim;
    for (const status of application.transitions) next = await persistClaimTransition(tx, next, status);
    for (const task of application.tasks) await openClaimTask(tx, claim.id, task.kind, task.reason);
    let authorizationVisitDecremented = false;
    if (application.matched && (next.status === "PAID" || next.status === "PATIENT_BALANCE") && encounter!.authorizationId) {
      const [authorization] = await tx.select().from(s.authorizations).where(and(
        eq(s.authorizations.id, encounter!.authorizationId), eq(s.authorizations.patientId, encounter!.patientId), eq(s.authorizations.payerId, claim.payerId),
      )).for("update");
      if (!authorization) throw new RemitPostingError(422, "AUTHORIZATION_NOT_FOUND", "Linked authorization must belong to the claim's patient and payer");
      // Required prototype semantics: release one used visit on payment. At zero
      // there is no used visit to release; never violate the nonnegative counter.
      const released = await tx.update(s.authorizations).set({ visitsUsed: sql`${s.authorizations.visitsUsed} - 1` })
        .where(and(eq(s.authorizations.id, authorization.id), gt(s.authorizations.visitsUsed, 0))).returning({ id: s.authorizations.id });
      authorizationVisitDecremented = released.length === 1;
    }
    const result: RemitPostingResult = { remitId: envelope.id, claimId: claim.id, status: next.status,
      matched: application.matched, duplicate: false, flags: application.flags, authorizationVisitDecremented };
    await tx.insert(s.remits).values({ id: envelope.id, claimId: claim.id, payerIcn: envelope.payerIcn, receivedOn: envelope.receivedOn,
      paidCents: application.paidCents, patientResponsibilityCents: application.patientResponsibilityCents, adjustmentCents: application.adjustmentCents,
      detailJson: JsonObjectSchema.parse({ envelope, result, source, claimVersion: claim.version, transitions: application.transitions }),
    });
    if (application.lines.length) await tx.insert(s.remitLines).values(application.lines.map((line) => ({
      remitId: envelope.id, claimLineId: line.claimLineId, paidCents: line.paidCents, patientResponsibilityCents: line.patientResponsibilityCents,
      adjustmentCents: line.adjustmentCents, contractualWriteOffCents: line.contractualWriteOffCents,
      // The legacy single CARC is a primary display value; retain every amount/code.
      carc: line.adjustments[0]?.carc ?? null, rarc: line.rarc,
      detailJson: JsonObjectSchema.parse({ cptCode: line.cptCode, units: line.units, chargeCents: line.chargeCents, adjustments: line.adjustments }),
    })));
    await tx.insert(s.auditEvents).values({ actor: "SYN-REMIT-POSTER", action: application.matched ? "REMIT_POSTED" : "REMIT_UNMATCHED",
      entity: "Remit", entityId: envelope.id, at: new Date().toISOString(),
      detailJson: JsonObjectSchema.parse({ claimId: claim.id, claimVersion: claim.version, from: claim.status, to: next.status,
        transitions: application.transitions, flags: application.flags, authorizationVisitDecremented }),
    });
    return result;
  });
}
