import type { Rule } from "../types.js";

// Test example only: deliberately absent from the public barrel and default pack.
export const ALWAYS_FLAG: Rule = Object.freeze<Rule>({
  id: "ALWAYS_FLAG",
  version: 1,
  description: "Synthetic example that always records a test finding.",
  evaluate: () => ({ outcome: "FLAG", code: "ALWAYS_FLAG", message: "Synthetic test finding." }),
});
