import { ClaimSchema, type Claim, type ClaimStatus } from "./models.js";

const transitions: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  DRAFT: ["SCRUBBED", "BLOCKED"],
  BLOCKED: ["SCRUBBED", "DRAFT"],
  SCRUBBED: ["SUBMITTED", "BLOCKED"],
  SUBMITTED: ["ACCEPTED", "REJECTED"],
  ACCEPTED: ["PAID", "DENIED", "PATIENT_BALANCE"],
  DENIED: ["SCRUBBED"],
  REJECTED: ["DRAFT"],
  PAID: [],
  PATIENT_BALANCE: ["PAID"],
  // Retained in the canonical enum for shadow evidence; no active lifecycle edges.
  SHADOWED: [],
};

export class IllegalClaimTransition extends Error {
  readonly code = "ILLEGAL_CLAIM_TRANSITION";
  constructor(readonly from: ClaimStatus, readonly to: ClaimStatus) {
    super(`Illegal claim transition: ${from} -> ${to}`);
    this.name = "IllegalClaimTransition";
  }
}

/** A transition changes only status/version and returns an independent claim.
 * Repeating a command without changing status is the caller's responsibility;
 * self-transitions are not additional edges in the lifecycle.
 */
export function transitionClaim(claim: Claim, to: ClaimStatus): Claim {
  const current = ClaimSchema.parse(claim);
  if (!transitions[current.status].includes(to)) throw new IllegalClaimTransition(current.status, to);
  return ClaimSchema.parse({ ...current, status: to,
    version: current.version + (current.status === "DENIED" && to === "SCRUBBED" ? 1 : 0),
  });
}
