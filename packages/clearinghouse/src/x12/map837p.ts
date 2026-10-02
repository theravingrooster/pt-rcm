import type { ClaimDocument } from "@pt-rcm/domain";

// Mapping outline only; not an implementation guide, serializer, or valid X12.
export const MAP_837P_LOOPS = Object.freeze([
  { id: "1000A", name: "Submitter" },
  { id: "1000B", name: "Receiver" },
  { id: "2000A", name: "Billing provider hierarchy" },
  { id: "2000B", name: "Subscriber hierarchy" },
  { id: "2300", name: "Claim information" },
  { id: "2400", name: "Service line information" },
] as const);

export class NotImplemented extends Error {
  constructor() {
    super("NotImplemented: 837P mapping is not implemented; no X12 is generated");
    this.name = "NotImplemented";
  }
}

export function map837p(_document: ClaimDocument): never {
  throw new NotImplemented();
}
