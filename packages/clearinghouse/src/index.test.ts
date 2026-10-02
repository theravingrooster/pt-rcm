import { describe, expect, it } from "vitest";
import { FixtureClearinghouse, StediClearinghouse, type ClearinghousePort } from "./index.js";

describe("fixture clearinghouse", () => {
  it("accepts a synthetic claim and does not call a payer", async () => {
    const clearinghouse = new FixtureClearinghouse();
    const ack = await clearinghouse.submitClaim({ memberId: "SYN-1" });
    expect(ack.status).toBe("accepted");
    expect(ack.icn.startsWith("SYN-")).toBe(true);
    expect(clearinghouse.calls).toEqual(["submit"]);
  });
});

describe("disabled live clearinghouse", () => {
  const live: ClearinghousePort = new StediClearinghouse("SYN-NOT-A-KEY");
  it.each([
    () => live.checkEligibility({ memberId: "SYN-1" }),
    () => live.submitClaim({ memberId: "SYN-1" }),
    () => live.fetchRemits("2026-10-01"),
  ])("throws for every operation", async (operation) => {
    await expect(operation()).rejects.toThrow("ClearinghouseDisabled");
  });
});
