import { and, desc, eq } from "drizzle-orm";
import { ClaimStatusSchema, IdSchema, transitionClaim, type Claim, type ClaimStatus } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { openClaimTask } from "./tasks.js";
import * as s from "./schema.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class ClaimLifecycleError extends Error {
  constructor(readonly status: 404 | 409, readonly code: string, message: string) {
    super(message); this.name = "ClaimLifecycleError";
  }
}

/** Internal persistence boundary: caller holds the encounter and claim locks.
 * State and any resulting work item commit or roll back together.
 */
export async function persistClaimTransition(tx: Transaction, claim: Claim, to: ClaimStatus) {
  const next = transitionClaim(claim, to);
  await tx.update(s.claims).set({ status: next.status, version: next.version }).where(eq(s.claims.id, claim.id));
  if (to === "DENIED") await openClaimTask(tx, claim.id, "DENIAL_REVIEW", "Review the denied claim and correct it before re-scrubbing.");
  if (to === "PATIENT_BALANCE") await openClaimTask(tx, claim.id, "PATIENT_INVOICE", "Prepare an invoice for the recorded patient balance.");
  return next;
}

const recordedStatuses = ClaimStatusSchema.extract(["DRAFT", "ACCEPTED", "REJECTED", "PAID", "DENIED", "PATIENT_BALANCE"]);
type RecordedStatus = typeof recordedStatuses._type;

/** For recorded fixture outcomes and an explicit reset after rejection. This
 * performs no clearinghouse I/O. SCRUBBED/SUBMITTED must use scrub/submit so this
 * entry point cannot bypass rule evaluation or fixture submission safeguards.
 */
export async function transitionStoredClaim(db: Database, organizationId: string, claimId: string, to: RecordedStatus) {
  IdSchema.parse(organizationId); IdSchema.parse(claimId); recordedStatuses.parse(to);
  return db.transaction(async (tx) => {
    const [reference] = await tx.select({ encounterId: s.claims.encounterId }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.claims.id, claimId), eq(s.encounters.organizationId, organizationId)));
    if (!reference) throw new ClaimLifecycleError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    await tx.select({ id: s.encounters.id }).from(s.encounters).where(eq(s.encounters.id, reference.encounterId)).for("update");
    const siblings = await tx.select().from(s.claims).where(eq(s.claims.encounterId, reference.encounterId)).orderBy(desc(s.claims.version)).for("update");
    const claim = siblings.find((row) => row.id === claimId)!;
    if (siblings[0]!.id !== claimId) throw new ClaimLifecycleError(409, "CLAIM_SUPERSEDED", "Only the latest claim version can change state");
    const next = await persistClaimTransition(tx, claim, to);
    if (to === "DRAFT") await tx.update(s.encounters).set({ status: "DRAFT" }).where(eq(s.encounters.id, reference.encounterId));
    await tx.insert(s.auditEvents).values({ actor: "SYN-LIFECYCLE", action: "CLAIM_STATUS_CHANGED", entity: "Claim", entityId: claimId,
      at: new Date().toISOString(), detailJson: { from: claim.status, to, version: next.version },
    });
    return next;
  });
}
