import { describe, expect, it } from "vitest";
import { rulesReady } from "./index.js";

describe("rules", () => {
  it("is a stub and does not submit claims", () => {
    expect(rulesReady).toBe(false);
  });
});
