// Local fixture with plain-English summaries, not an adjudication or remediation rule.
// Reference: https://x12.org/codes/claim-adjustment-reason-codes
// Names include the adjustment group and CARC (for example, CO + 4).
const carcFixtures = Object.freeze(([
  { name: "CO-4", meaning: "The billed procedure and modifier do not match." },
  { name: "CO-16", meaning: "Required claim information is missing or the submitted billing information has errors." },
  { name: "CO-197", meaning: "Required prior approval, notification, or pre-treatment steps are missing." },
  { name: "PR-1", meaning: "The amount is assigned to the patient's deductible." },
  { name: "PR-2", meaning: "The amount is assigned to the patient's coinsurance." },
  { name: "PR-3", meaning: "The amount is assigned to the patient's copay." },
  { name: "OA-23", meaning: "The adjustment reflects payments or adjustments already made by a previous payer." },
] as const).map((row) => Object.freeze(row)));

export type CarcFixture = (typeof carcFixtures)[number];
export type CarcFixtureName = CarcFixture["name"];

export function loadCarcFixtures(): readonly CarcFixture[] {
  return carcFixtures;
}

export function getCarcFixture(name: string): CarcFixture | undefined {
  return carcFixtures.find((row) => row.name === name);
}
