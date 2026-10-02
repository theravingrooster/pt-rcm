import { describe, expect, it } from "vitest";
import { FixtureClearinghouse } from "./index.js";

describe("fixture clearinghouse", () => {
  it("accepts a synthetic claim and does not call a payer", async () => {
    const clearinghouse = new FixtureClearinghouse();
    const ack = await clearinghouse.submitClaim({ memberId: "SYN-1" });
    expect(ack.status).toBe("accepted");
    expect(ack.icn.startsWith("SYN-")).toBe(true);
    expect(clearinghouse.calls).toEqual(["submit"]);
  });
});
