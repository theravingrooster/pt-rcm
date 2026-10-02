import { describe, expect, it } from "vitest";
import { ClaimStatusSchema, type ClaimStatus } from "./models.js";
import { IllegalClaimTransition, transitionClaim } from "./lifecycle.js";
import { makeClaimDocumentInput } from "./testing/claimDocument.js";

const edges: [ClaimStatus, ClaimStatus][] = [
  ["DRAFT", "SCRUBBED"], ["DRAFT", "BLOCKED"],
  ["BLOCKED", "SCRUBBED"], ["BLOCKED", "DRAFT"],
  ["SCRUBBED", "SUBMITTED"], ["SCRUBBED", "BLOCKED"],
  ["SUBMITTED", "ACCEPTED"], ["SUBMITTED", "REJECTED"],
  ["ACCEPTED", "PAID"], ["ACCEPTED", "DENIED"], ["ACCEPTED", "PATIENT_BALANCE"],
  ["DENIED", "SCRUBBED"], ["REJECTED", "DRAFT"],
];

describe("claim lifecycle", () => {
  it.each(edges)("allows %s -> %s without changing clinical or financial facts", (from, to) => {
    const claim = { ...makeClaimDocumentInput().claim, status: from, version: 3, snapshotJson: { evidence: { units: 3 } } };
    const before = structuredClone(claim);
    const next = transitionClaim(claim, to);
    expect(next).toEqual({ ...before, status: to, version: from === "DENIED" ? 4 : 3 });
    expect(claim).toEqual(before);
    expect(next).not.toBe(claim);
    expect(next.snapshotJson).not.toBe(claim.snapshotJson);
  });

  const illegal = ClaimStatusSchema.options.flatMap((from) => ClaimStatusSchema.options
    .filter((to) => !edges.some(([a, b]) => a === from && b === to)).map((to) => [from, to] as const));
  it.each(illegal)("rejects %s -> %s, including terminal states and self-transitions", (from, to) => {
    const claim = { ...makeClaimDocumentInput().claim, status: from };
    expect(() => transitionClaim(claim, to)).toThrow(IllegalClaimTransition);
    expect(() => transitionClaim(claim, to)).toThrow(`${from} -> ${to}`);
  });

  it("rejects a denial revision that would overflow the stored version", () => {
    expect(() => transitionClaim({ ...makeClaimDocumentInput().claim, status: "DENIED", version: 2_147_483_647 }, "SCRUBBED")).toThrow();
  });
});
