import { describe, expect, it } from "vitest";
import { submitClaim } from "./index.js";

describe("fixture clearinghouse", () => {
  it("does not call a payer", async () => {
    const result = await submitClaim({ memberId: "SYN-1" });
    expect(result.submitted).toBe(false);
    expect(result.adapter).toBe("fixture");
  });
});
