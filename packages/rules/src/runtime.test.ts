import { describe, expect, it } from "vitest";
import * as api from "./index.js";
import { runRules, type Rule, type RuleContext, type RuleResult } from "./index.js";
import { ALWAYS_FLAG } from "./testing/alwaysFlag.js";
import { makeContext } from "./testing/fixtures.js";

const rule = (id: string, result: RuleResult): Rule => ({ id, version: 1, description: "Synthetic runtime test", evaluate: () => result });
const flagsAndBlock = [
  rule("Z_FLAG", { outcome: "FLAG", code: "SYN_Z", message: "Synthetic Z flag" }),
  rule("A_BLOCK", { outcome: "BLOCK", code: "SYN_BLOCK", message: "Synthetic block" }),
  rule("M_FLAG", { outcome: "FLAG", code: "SYN_M", message: "Synthetic M flag" }),
];

describe("runRules", () => {
  it("collects two flags and a block, runs every rule, and blocks active submission", () => {
    const evaluated: string[] = [];
    const rules = flagsAndBlock.map((entry) => ({ ...entry, evaluate: (ctx: RuleContext) => {
      evaluated.push(entry.id);
      return entry.evaluate(ctx);
    } }));
    const run = runRules(rules, makeContext());
    expect(evaluated).toEqual(["A_BLOCK", "M_FLAG", "Z_FLAG"]);
    expect(run.findings.map(({ ruleId, outcome }) => [ruleId, outcome])).toEqual([
      ["A_BLOCK", "BLOCK"], ["M_FLAG", "FLAG"], ["Z_FLAG", "FLAG"],
    ]);
    expect(run.findings.every((finding) => finding.shadow === false)).toBe(true);
    expect(run.blocks).toEqual([run.findings[0]]);
    expect(run.downgrades).toEqual([]);
    expect(run.submissionAllowed).toBe(false);
    expect(rules.map(({ id }) => id)).toEqual(["Z_FLAG", "A_BLOCK", "M_FLAG"]);
  });

  it("retains the same findings in shadow mode without blocking", () => {
    const active = runRules(flagsAndBlock, makeContext());
    const shadow = runRules(flagsAndBlock, makeContext("shadow"));
    expect(shadow.findings).toEqual(active.findings.map((finding) => ({ ...finding, shadow: true })));
    expect(shadow.blocks).toEqual([]);
    expect(shadow.downgrades).toEqual([]);
    expect(shadow.submissionAllowed).toBe(true);
  });

  it.each(["active", "shadow"] as const)("catches rule throws as RULE_CRASH and continues in %s mode", (mode) => {
    const crash: Rule = { id: "AA_CRASH", version: 3, description: "Synthetic crash", evaluate: () => { throw new Error("SYN private exception payload"); } };
    const run = runRules([ALWAYS_FLAG, crash], makeContext(mode));
    expect(run.findings).toHaveLength(2);
    expect(run.findings[0]).toMatchObject({ ruleId: "AA_CRASH", ruleVersion: 3, outcome: "BLOCK", code: "RULE_CRASH", shadow: mode === "shadow" });
    expect(run.findings[0]).toHaveProperty("message", expect.stringContaining("AA_CRASH"));
    expect(JSON.stringify(run)).not.toContain("private exception payload");
    expect(run.findings[1]).toMatchObject({ ruleId: "ALWAYS_FLAG", outcome: "FLAG" });
    expect(run.blocks).toHaveLength(mode === "active" ? 1 : 0);
    expect(run.submissionAllowed).toBe(mode === "shadow");
  });

  it("isolates context from mutation by a broken rule, including subsequent rules", () => {
    const ctx = makeContext();
    const before = structuredClone(ctx);
    const mutate: Rule = { id: "A_MUTATE", version: 1, description: "Synthetic mutator", evaluate: (context) => {
      (context.allocatedUnits.lines[0] as { units: number }).units = 99;
      return { outcome: "PASS" };
    } };
    const check: Rule = { id: "Z_CHECK", version: 1, description: "Synthetic unchanged input check", evaluate: (context) => {
      expect(context.allocatedUnits.lines[0]!.units).toBe(2);
      expect(Object.isFrozen(context.encounter)).toBe(true);
      expect(Object.isFrozen(context.minuteLines[0])).toBe(true);
      return { outcome: "PASS" };
    } };
    const run = runRules([check, mutate], ctx);
    expect(run.findings).toMatchObject([{ code: "RULE_CRASH" }, { ruleId: "Z_CHECK", outcome: "PASS" }]);
    expect(ctx).toEqual(before);
    expect(Object.isFrozen(ctx.encounter)).toBe(false);
  });

  it("returns proposed downgrades without applying them", () => {
    const ctx = makeContext();
    const before = structuredClone(ctx);
    const proposal = { outcome: "DOWNGRADE" as const, code: "SYN_REDUCE", message: "Synthetic reduction", linePatches: [{ lineIndex: 0, units: 1 }] };
    const run = runRules([rule("REDUCE", proposal)], ctx);
    expect(run.downgrades).toMatchObject([{ ...proposal, ruleId: "REDUCE", shadow: false }]);
    expect(run.submissionAllowed).toBe(true);
    expect(ctx).toEqual(before);
    run.downgrades[0]!.linePatches[0]!.units = 0;
    expect(proposal.linePatches[0]!.units).toBe(1);
  });

  it("keeps shadow downgrades in findings but out of actionable proposals", () => {
    const run = runRules([rule("REDUCE", { outcome: "DOWNGRADE", code: "SYN", message: "Synthetic", linePatches: [{ lineIndex: 0, units: 1 }] })], makeContext("shadow"));
    expect(run.findings[0]).toMatchObject({ outcome: "DOWNGRADE", shadow: true });
    expect(run.downgrades).toEqual([]);
    expect(run.submissionAllowed).toBe(true);
  });

  it.each([
    { outcome: "UNKNOWN" },
    { outcome: "FLAG", code: "", message: "Synthetic" },
    { outcome: "DOWNGRADE", code: "SYN", message: "Synthetic", linePatches: [] },
    { outcome: "DOWNGRADE", code: "SYN", message: "Synthetic", linePatches: [{ lineIndex: 2, units: 1 }] },
    { outcome: "DOWNGRADE", code: "SYN", message: "Synthetic", linePatches: [{ lineIndex: 0, units: 3 }] },
    { outcome: "DOWNGRADE", code: "SYN", message: "Synthetic", linePatches: [{ lineIndex: 0, units: -1 }] },
    { outcome: "DOWNGRADE", code: "SYN", message: "Synthetic", linePatches: [{ lineIndex: 0, units: 1.5 }] },
    { outcome: "DOWNGRADE", code: "SYN", message: "Synthetic", linePatches: [{ lineIndex: 0, units: 1, minutes: 30 }] },
    null,
  ])("treats malformed or unsafe results as a crash, case %#", (result) => {
    const run = runRules([rule("BAD_RESULT", result as RuleResult), ALWAYS_FLAG], makeContext());
    expect(run.blocks).toMatchObject([{ ruleId: "BAD_RESULT", code: "RULE_CRASH" }]);
    expect(run.findings).toHaveLength(2);
    expect(run.submissionAllowed).toBe(false);
  });

  it("is deterministic by id and then version for equal ids", () => {
    const rules = [rule("Z", { outcome: "PASS" }), { ...rule("A", { outcome: "PASS" }), version: 2 }, rule("A", { outcome: "PASS" })];
    const ctx = makeContext();
    const run = runRules(rules, ctx);
    expect(run.findings.map(({ ruleId, ruleVersion }) => [ruleId, ruleVersion])).toEqual([["A", 1], ["A", 2], ["Z", 1]]);
    expect(runRules([...rules].reverse(), ctx)).toEqual(run);
  });

  it("supplies every context field without recalculating allocation or patient totals", () => {
    const ctx = makeContext();
    const check: Rule = { id: "CTX", version: 1, description: "Synthetic context check", evaluate: (received) => {
      expect(received).toEqual(ctx);
      return { outcome: "PASS" };
    } };
    expect(runRules([check], ctx).findings[0]!.outcome).toBe("PASS");
  });

  it("rejects an invalid mode or fractional cents before evaluating rules", () => {
    expect(() => runRules([], { ...makeContext(), mode: "invalid" } as unknown as RuleContext)).toThrow();
    expect(() => runRules([], { ...makeContext(), yearToDateBilledCents: 1.5 })).toThrow();
  });

  it("records invalid rule metadata as a crash rather than silently allowing submission", () => {
    expect(runRules([{ ...ALWAYS_FLAG, version: 0 }], makeContext()).blocks[0]).toMatchObject({ code: "RULE_CRASH", ruleId: "ALWAYS_FLAG" });
  });

  it("registers PT version 4 while keeping ALWAYS_FLAG test-only", () => {
    expect(api.defaultRulePack).toHaveLength(9);
    expect(api.defaultRulePackVersion).toBe(4);
    expect(api.defaultRulePackMode).toBe("active");
    expect(api.defaultRulePack.some((rule) => rule.id === "pta-cq-modifier")).toBe(true);
    expect(api.defaultRulePack.some((rule) => rule.id === "ALWAYS_FLAG")).toBe(false);
    expect(Object.isFrozen(api.defaultRulePack)).toBe(true);
    expect(api).not.toHaveProperty("ALWAYS_FLAG");
    expect(runRules([], makeContext())).toEqual({ findings: [], blocks: [], downgrades: [], submissionAllowed: true });
    expect(runRules([ALWAYS_FLAG], makeContext()).findings[0]).toMatchObject({ ruleId: "ALWAYS_FLAG", outcome: "FLAG", code: "ALWAYS_FLAG" });
  });
});
