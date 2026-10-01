import test from "node:test";
import assert from "node:assert/strict";
import { projectStatus } from "./index.js";

test("seed reports ready", () => {
  assert.equal(projectStatus(), "claimguard seed ready");
});
