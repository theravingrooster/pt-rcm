import { describe, expect, it } from "vitest";
import { copyRulePackToShadow, ptEligibilityShadowPack, ptPtaPack, ptShadowPack, resolveRulePack, rulePackManifest } from "./packVersioning.js";
import { coverageInactiveRule, ptPack, ptaCqModifierRule, timedCodeCapRule } from "./ptPack.js";
import { runRules } from "./runtime.js";
import { makeContext } from "./testing/fixtures.js";

describe("rule pack versions", () => {
  it("copies the active roster into immutable v2 SHADOW and adds only the cap", () => {
    expect(ptPack).toMatchObject({ id: "outpatient-pt", version: 1, mode: "active" });
    expect(ptShadowPack).toMatchObject({ id: "outpatient-pt", version: 2, mode: "shadow" });
    expect(ptShadowPack.rules.slice(0, ptPack.rules.length)).toEqual(ptPack.rules);
    expect(ptShadowPack.rules.at(-1)).toBe(timedCodeCapRule);
    expect(ptPack.rules.some(({ id }) => id === "timed-code-cap")).toBe(false);
    expect(Object.isFrozen(ptShadowPack)).toBe(true);
    expect(Object.isFrozen(ptShadowPack.rules)).toBe(true);
    expect(copyRulePackToShadow(ptPack, 2, [timedCodeCapRule])).toEqual(ptShadowPack);
    expect(() => copyRulePackToShadow(ptPack, 1)).toThrow(/increase/);
    expect(() => copyRulePackToShadow(ptPack, 2, [ptPack.rules[0]!])).toThrow(/Duplicate/);
  });

  it("stages v3 with eligibility without editing either deployed roster", () => {
    expect(ptEligibilityShadowPack).toMatchObject({ id: "outpatient-pt", version: 3, mode: "shadow" });
    expect(ptEligibilityShadowPack.rules.slice(0, ptShadowPack.rules.length)).toEqual(ptShadowPack.rules);
    expect(ptEligibilityShadowPack.rules.at(-1)).toBe(coverageInactiveRule);
    expect(ptPack.rules.some(({ id }) => id === coverageInactiveRule.id)).toBe(false);
    expect(ptShadowPack.rules.some(({ id }) => id === coverageInactiveRule.id)).toBe(false);
    expect(Object.isFrozen(ptEligibilityShadowPack)).toBe(true);
    expect(Object.isFrozen(ptEligibilityShadowPack.rules)).toBe(true);
    expect(copyRulePackToShadow(ptShadowPack, 3, [coverageInactiveRule])).toEqual(ptEligibilityShadowPack);
  });

  it("builds a separate v4 active pack from v1 with only the PTA rule", () => {
    expect(ptPtaPack).toMatchObject({ id: "outpatient-pt", version: 4, mode: "active" });
    expect(ptPtaPack.rules.slice(0, ptPack.rules.length)).toEqual(ptPack.rules);
    expect(ptPtaPack.rules.at(-1)).toBe(ptaCqModifierRule);
    expect(ptPack.rules).toHaveLength(8);
    expect(ptShadowPack.rules.some(({ id }) => id === ptaCqModifierRule.id)).toBe(false);
    expect(ptEligibilityShadowPack.rules.some(({ id }) => id === ptaCqModifierRule.id)).toBe(false);
    expect(ptPtaPack.rules.some(({ id }) => id === coverageInactiveRule.id || id === timedCodeCapRule.id)).toBe(false);
    expect(Object.isFrozen(ptPtaPack)).toBe(true);
    expect(Object.isFrozen(ptPtaPack.rules)).toBe(true);
    expect(() => resolveRulePack({ ...rulePackManifest(ptPack), version: 4 })).toThrow(/roster/);
  });

  it("resolves only the exact rule references shipped with each deployed version", () => {
    for (const pack of [ptPack, ptShadowPack, ptEligibilityShadowPack, ptPtaPack]) {
      expect(resolveRulePack(rulePackManifest(pack)).rules).toBe(pack.rules);
    }
    const manifest = rulePackManifest(ptEligibilityShadowPack);
    expect(() => resolveRulePack({ ...manifest, version: 5 })).toThrow(/not deployed/);
    expect(() => resolveRulePack({ ...manifest, id: "foreign-pack" })).toThrow();
    expect(() => resolveRulePack({ ...manifest, rules: manifest.rules.slice(1) })).toThrow(/roster/);
    expect(() => resolveRulePack({ ...manifest, rules: [...manifest.rules, manifest.rules[0]] })).toThrow(/roster/);
    expect(() => resolveRulePack({ ...manifest, rules: [{ id: "arbitrary-rule", version: 1 }, ...manifest.rules.slice(1)] })).toThrow(/roster/);
    expect(() => resolveRulePack({ ...rulePackManifest(ptPack), rules: manifest.rules })).toThrow(/roster/);
    expect(() => resolveRulePack({ ...rulePackManifest(ptShadowPack), rules: manifest.rules })).toThrow(/roster/);
  });

  it("runs v2 as a shadow snapshot without changing v1 or actionable findings", () => {
    const ctx = makeContext("shadow");
    const before = structuredClone(ctx);
    const v1 = runRules(ptPack.rules, ctx);
    const v2 = runRules(ptShadowPack.rules, ctx);
    expect(v2.findings).toHaveLength(v1.findings.length + 1);
    expect(v2.findings.find(({ ruleId }) => ruleId === timedCodeCapRule.id)).toMatchObject({ shadow: true, outcome: "PASS" });
    expect(v2.blocks).toEqual([]);
    expect(v2.downgrades).toEqual([]);
    expect(ctx).toEqual(before);
  });

  it("runs v3 as a shadow snapshot, recording the missing-check flag without blocking", () => {
    const ctx = makeContext("shadow");
    const before = structuredClone(ctx);
    const v2 = runRules(ptShadowPack.rules, ctx);
    const v3 = runRules(ptEligibilityShadowPack.rules, ctx);
    expect(v3.findings).toHaveLength(v2.findings.length + 1);
    expect(v3.findings.find(({ ruleId }) => ruleId === coverageInactiveRule.id))
      .toMatchObject({ shadow: true, outcome: "FLAG", code: "ELIGIBILITY_NOT_RUN" });
    expect(v3.blocks).toEqual([]);
    expect(v3.downgrades).toEqual([]);
    expect(ctx).toEqual(before);
  });
});
