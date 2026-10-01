import { describe, expect, it } from "vitest";
import { projectStatus } from "./index.js";

describe("projectStatus", () => {
  it("names this prototype, not ClaimGuard", () => {
    expect(projectStatus()).toBe("pt-rcm skeleton ready");
  });
});
