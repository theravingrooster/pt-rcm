import { describe, expect, it } from "vitest";
import { copyRulePackToShadow, ptShadowPack, resolveRulePack, rulePackManifest } from "./packVersioning.js";
import { ptPack, timedCodeCapRule } from "./ptPack.js";
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

  it("resolves only the exact rule references shipped with each deployed version", () => {
    for (const pack of [ptPack, ptShadowPack]) {
      expect(resolveRulePack(rulePackManifest(pack)).rules).toBe(pack.rules);
    }
    const manifest = rulePackManifest(ptShadowPack);
    expect(() => resolveRulePack({ ...manifest, version: 3 })).toThrow(/not deployed/);
    expect(() => resolveRulePack({ ...manifest, id: "foreign-pack" })).toThrow();
    expect(() => resolveRulePack({ ...manifest, rules: manifest.rules.slice(1) })).toThrow(/roster/);
    expect(() => resolveRulePack({ ...manifest, rules: [...manifest.rules, manifest.rules[0]] })).toThrow(/roster/);
    expect(() => resolveRulePack({ ...manifest, rules: [{ id: "arbitrary-rule", version: 1 }, ...manifest.rules.slice(1)] })).toThrow(/roster/);
    expect(() => resolveRulePack({ ...rulePackManifest(ptPack), rules: manifest.rules })).toThrow(/roster/);
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
});
