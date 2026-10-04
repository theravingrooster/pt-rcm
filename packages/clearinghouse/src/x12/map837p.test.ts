import { describe, expect, it } from "vitest";
import { buildClaimDocument } from "@pt-rcm/domain";
import { makeClaimDocumentInput } from "../../../domain/src/testing/claimDocument.js";
import { MAP_837P_LOOPS, map837p, Synthetic837DocumentError } from "../index.js";

describe("synthetic 837P fixture writer", () => {
  it("renders the requested loops, GP in 2400, and three units for the 20+20 shoulder claim", () => {
    const doc = buildClaimDocument(makeClaimDocumentInput());
    const before = structuredClone(doc);
    const text = map837p(doc);
    expect(MAP_837P_LOOPS.map((loop) => loop.id)).toEqual(["1000A", "1000B", "2000A", "2000B", "2300", "2400"]);
    expect(text).toMatch(/^SYN\*FIXTURE-ONLY\*NOT-FOR-PAYER-SUBMISSION~/);
    expect(text).toContain(`NM1*85*2*${doc.billingProvider.name}*****XX*${doc.billingProvider.npi}~`);
    expect(text).toContain(`NM1*82*1*SYN RENDERING*****XX*${doc.renderingProvider.npi}~`);
    expect(text).toContain(`NM1*IL*1*${doc.subscriber.person?.lastName}*${doc.subscriber.person?.firstName}****MI*${doc.subscriber.memberId}~`);
    expect(text).toContain(`CLM*${doc.claimControlNumber}*135.00`);
    expect(text).toContain("HI*ABK:M25.511~");
    expect(text).toContain("SV1*HC:97110:GP*90.00*UN*2***1~");
    expect(text).toContain("SV1*HC:97530:GP*45.00*UN*1***1~");
    expect(doc.lines.reduce((sum, line) => sum + line.units, 0)).toBe(3);
    expect(text).not.toContain("ISA*");
    expect(doc).toEqual(before);
  });

  it("rejects missing subscriber demographics instead of fabricating them", () => {
    const doc = buildClaimDocument(makeClaimDocumentInput());
    expect(() => map837p({ ...doc, subscriber: { ...doc.subscriber, relationship: "SPOUSE", person: null } }))
      .toThrow(Synthetic837DocumentError);
    expect(() => map837p({ ...doc, subscriber: { ...doc.subscriber, relationship: "SPOUSE", person: null } }))
      .toThrow("requires recorded subscriber demographics");
  });

  it("rejects delimiter injection in free-text fields", () => {
    const doc = buildClaimDocument(makeClaimDocumentInput());
    expect(() => map837p({ ...doc, submitter: { ...doc.submitter, name: "SYN~NM1*IL*1*INJECTED" } }))
      .toThrow("segment delimiter");
    expect(() => map837p({ ...doc, submitter: { ...doc.submitter, name: "SYN:INJECTED" } }))
      .toThrow("component delimiter");
  });
});
