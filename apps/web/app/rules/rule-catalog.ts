// Navigation metadata only. Rule evaluation and pack rosters live in packages/rules.
export const ruleGroups = [
  { title: "Claim submission", steps: [
    { title: "Update coding", ids: ["zero-minute-timed", "eval-with-treatment", "timed-code-cap"] },
    { title: "Update modifiers", ids: ["gp-modifier", "pta-cq-modifier", "kx-threshold", "distinct-procedure"] },
    { title: "Add charge amounts", ids: ["eight-minute-applied"] },
    { title: "Finalize claim", ids: [] },
  ] },
  { title: "Validate claim", steps: [
    { title: "Coverage", ids: ["coverage-inactive"] },
    { title: "Authorization", ids: ["auth-visits"] },
    { title: "Plan of care", ids: ["plan-of-care"] },
    { title: "Provider and payer readiness", ids: [] },
  ] },
] as const;

// Outcomes describe what each code-backed rule can return, including PASS.
export const ruleOutcomes: Record<string, readonly string[]> = {
  "gp-modifier": ["PASS", "DOWNGRADE"],
  "pta-cq-modifier": ["PASS", "DOWNGRADE"],
  "eight-minute-applied": ["PASS", "FLAG", "BLOCK"],
  "zero-minute-timed": ["PASS", "BLOCK"],
  "kx-threshold": ["PASS", "FLAG", "BLOCK"],
  "auth-visits": ["PASS", "FLAG", "BLOCK"],
  "plan-of-care": ["PASS", "BLOCK"],
  "eval-with-treatment": ["PASS", "FLAG"],
  "distinct-procedure": ["PASS", "FLAG"],
  "coverage-inactive": ["PASS", "FLAG", "BLOCK"],
  "timed-code-cap": ["PASS", "FLAG"],
};
