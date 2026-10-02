import { describe, expect, it } from "vitest";
import { buildClaimDocument } from "@pt-rcm/domain";
import { makeClaimDocumentInput } from "../../../domain/src/testing/claimDocument.js";
import { MAP_837P_LOOPS, map837p, NotImplemented } from "../index.js";

describe("837P mapping outline only", () => {
  it("lists the requested loop outline", () => {
    expect(MAP_837P_LOOPS.map((loop) => loop.id)).toEqual(["1000A", "1000B", "2000A", "2000B", "2300", "2400"]);
  });
  it("throws NotImplemented even for a valid document and leaves it unchanged", () => {
    const doc = buildClaimDocument(makeClaimDocumentInput());
    const before = structuredClone(doc);
    expect(() => map837p(doc)).toThrow(NotImplemented);
    expect(() => map837p(doc)).toThrow("no X12 is generated");
    expect(doc).toEqual(before);
  });
});
