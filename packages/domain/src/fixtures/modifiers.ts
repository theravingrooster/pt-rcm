// Local reference allowlist only; modifier enforcement belongs in versioned rules.
const modifierFixtures = Object.freeze([
  "GP", "GO", "GN", "KX", "59", "XE", "XS", "XP", "XU", "CQ",
] as const);

export type ModifierFixture = (typeof modifierFixtures)[number];

export function loadModifierFixtures(): readonly ModifierFixture[] {
  return modifierFixtures;
}

export function getModifierFixture(code: string): ModifierFixture | undefined {
  return modifierFixtures.find((modifier) => modifier === code);
}
