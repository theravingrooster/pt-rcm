import { describe, expect, it } from "vitest";
import { applyDowngrades, runRules, type DowngradeFinding, type LinePatch, type Rule } from "./index.js";
import { makeContext, makeDraft } from "./testing/fixtures.js";

function proposal(linePatches: LinePatch[] = [{ lineIndex: 0, units: 1 }]): DowngradeFinding {
  return { ruleId: "SYN_REDUCE", ruleVersion: 1, description: "Synthetic reduction", encounterId: makeContext().encounter.id,
    outcome: "DOWNGRADE", code: "SYN_REDUCE", message: "Synthetic reduction", linePatches, shadow: false };
}

describe("applyDowngrades", () => {
  it("applies a runtime proposal to a new draft, preserving inputs and clinical facts", () => {
    const ctx = makeContext();
    const draft = makeDraft(ctx);
    const before = structuredClone(draft);
    const downgrade: Rule = { id: "SYN_REDUCE", version: 1, description: "Synthetic reduction",
      evaluate: () => ({ outcome: "DOWNGRADE", code: "SYN_REDUCE", message: "Synthetic reduction", linePatches: [{ lineIndex: 0, units: 1 }] }) };
    const run = runRules([downgrade], ctx);
    const result = applyDowngrades(draft, run.downgrades);
    expect(result.lines.map((line) => line.units)).toEqual([1, 1]);
    expect(result.lines.map(({ units: _units, ...facts }) => facts)).toEqual(before.lines.map(({ units: _units, ...facts }) => facts));
    expect(draft).toEqual(before);
    expect(result).not.toBe(draft);
    expect(result.lines[0]).not.toBe(draft.lines[0]);
    expect(result.lines[1]!.diagnosisPointers).not.toBe(draft.lines[1]!.diagnosisPointers);
    expect(ctx.allocatedUnits.lines[0]!.units).toBe(2);
    expect(run.downgrades[0]!.linePatches).toEqual([{ lineIndex: 0, units: 1 }]);
  });

  it("combines overlapping absolute unit ceilings by minimum, independent of order", () => {
    const draft = makeDraft();
    const proposals = [proposal(), proposal([{ lineIndex: 0, units: 0 }])];
    const result = applyDowngrades(draft, proposals);
    expect(result.lines.map((line) => line.units)).toEqual([0, 1]);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.minutes).toBe(20);
    expect(applyDowngrades(draft, [...proposals].reverse())).toEqual(result);
  });

  it("never applies a shadow proposal, even if findings are passed directly", () => {
    const draft = makeDraft();
    const result = applyDowngrades(draft, [{ ...proposal(), shadow: true }]);
    expect(result).toEqual(draft);
    expect(result).not.toBe(draft);
  });

  it.each([
    { lineIndex: 0, units: 3 }, { lineIndex: 2, units: 1 }, { lineIndex: -1, units: 1 },
    { lineIndex: 0, units: -1 }, { lineIndex: 0, units: 0.5 },
    { lineIndex: 0, units: 1, minutes: 99 }, { lineIndex: 0, units: 1, cptCode: "97140" },
    { lineIndex: 0, units: 1, diagnosisPointers: [1] },
  ])("rejects invalid patches atomically, case %#", (patch) => {
    const draft = makeDraft();
    const before = structuredClone(draft);
    expect(() => applyDowngrades(draft, [proposal(), proposal([patch])])).toThrow();
    expect(draft).toEqual(before);
  });

  it("rejects proposals belonging to another encounter", () => {
    expect(() => applyDowngrades(makeDraft(), [{ ...proposal(), encounterId: "10000000-0000-4000-8000-000000000999" }])).toThrow("different encounter");
  });

  it("returns a detached draft even with no proposals", () => {
    const draft = makeDraft();
    const copy = applyDowngrades(draft, []);
    expect(copy).toEqual(draft);
    expect(copy.lines).not.toBe(draft.lines);
  });
});
