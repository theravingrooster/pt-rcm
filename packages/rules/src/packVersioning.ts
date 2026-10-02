import { z } from "zod";
import { coverageInactiveRule, ptPack, timedCodeCapRule } from "./ptPack.js";
import type { Rule } from "./types.js";

export type VersionedRulePack = Readonly<{
  id: string;
  version: number;
  mode: "active" | "shadow";
  rules: readonly Rule[];
}>;

/** Staging copies the deployed roster into a new version; it never edits the source pack. */
export function copyRulePackToShadow(source: Pick<VersionedRulePack, "id" | "version" | "rules">,
  version: number, addedRules: readonly Rule[] = []): VersionedRulePack {
  if (!Number.isSafeInteger(version) || version <= source.version) throw new RangeError("Shadow version must increase");
  const rules = [...source.rules, ...addedRules];
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new TypeError("Duplicate rule ID in pack");
  return Object.freeze({ id: source.id, version, mode: "shadow" as const, rules: Object.freeze(rules) });
}

// The new rule is present only in this staged version. Current execution mode
// comes from the database row status after a promotion, not this seed label.
export const ptShadowPack = copyRulePackToShadow(ptPack, 2, [timedCodeCapRule]);

// v1 and v2 retain their exact deployed rosters. Eligibility enters a new
// candidate so existing audit rows continue to identify the policy they ran.
export const ptEligibilityShadowPack = copyRulePackToShadow(ptShadowPack, 3, [coverageInactiveRule]);

export const RulePackManifestSchema = z.object({
  id: z.literal("outpatient-pt"),
  version: z.number().int().positive(),
  rules: z.array(z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict()).min(1),
}).strict();
export type RulePackManifest = z.infer<typeof RulePackManifestSchema>;

/** Store only references to deployed rule code; executable functions never enter JSON. */
export function rulePackManifest(pack: Pick<VersionedRulePack, "id" | "version" | "rules">): RulePackManifest {
  return RulePackManifestSchema.parse({ id: pack.id, version: pack.version,
    rules: pack.rules.map(({ id, version }) => ({ id, version })) });
}

/** Resolve a stored manifest only when it exactly matches a deployed version. */
export function resolveRulePack(value: unknown): Pick<VersionedRulePack, "id" | "version" | "rules"> {
  const manifest = RulePackManifestSchema.parse(value);
  const pack = [ptPack, ptShadowPack, ptEligibilityShadowPack]
    .find((entry) => entry.id === manifest.id && entry.version === manifest.version);
  if (!pack) throw new TypeError("Rule pack version is not deployed");
  const expected = rulePackManifest(pack).rules.map(({ id, version }) => `${id}@${version}`).sort();
  const actual = manifest.rules.map(({ id, version }) => `${id}@${version}`).sort();
  if (expected.length !== actual.length || expected.some((ref, index) => ref !== actual[index])) {
    throw new TypeError("Stored rule pack roster differs from deployed version");
  }
  return pack;
}
