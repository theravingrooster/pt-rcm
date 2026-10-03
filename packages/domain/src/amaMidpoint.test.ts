import { describe, expect, it } from "vitest";
import { allocateAmaMidpointUnits, allocateUnits, loadMedicareMinuteLadder, type UnitAllocationInputLine } from "./index.js";

// CPT is an AMA-licensed code set; these codes are local test examples only.
const timed = (cptCode: string, minutes: number): UnitAllocationInputLine => ({ cptCode, minutes, timed: true });

describe("allocateAmaMidpointUnits", () => {
  it.each([
    [0, 0, 0], [7, 0, 7], [8, 1, 0], [22, 1, 7],
    [23, 2, 0], [37, 2, 7], [38, 3, 0], [1000, 67, 0],
  ])("rounds one %i-minute code to %i units, leaving %i minutes", (minutes, units, unusedMinutes) => {
    expect(allocateAmaMidpointUnits([timed("97110", minutes)])).toMatchObject({
      lines: [{ cptCode: "97110", minutes, units, remainderMinutes: unusedMinutes }],
      totalTimedMinutes: minutes, totalUnits: units, unusedMinutes,
    });
  });

  it("disagrees with the Medicare daily sum for 20 minutes of two distinct codes", () => {
    const lines = [timed("97110", 20), timed("97530", 20)];
    expect(allocateAmaMidpointUnits(lines)).toEqual({
      lines: [
        { cptCode: "97110", minutes: 20, units: 1, remainderMinutes: 5 },
        { cptCode: "97530", minutes: 20, units: 1, remainderMinutes: 5 },
      ],
      totalTimedMinutes: 40, totalUnits: 2, unusedMinutes: 10, flags: [],
    });
    expect(allocateUnits(lines, loadMedicareMinuteLadder()).totalUnits).toBe(3);
  });

  it.each([
    { minutes: [7, 7], codes: ["97110", "97530"], units: [0, 0], total: 0 },
    { minutes: [8, 8], codes: ["97110", "97530"], units: [1, 1], total: 2 },
    { minutes: [20, 20], codes: ["97110", "97110"], units: [2, 1], total: 3 },
    { minutes: [4, 4], codes: ["97110", "97110"], units: [1, 0], total: 1 },
    { minutes: [8, 8], codes: ["97110", "97110"], units: [1, 0], total: 1 },
    { minutes: [15, 8], codes: ["97110", "97110"], units: [1, 1], total: 2 },
  ])("counts code minutes independently: $codes at $minutes gives $units", ({ minutes, codes, units, total }) => {
    const result = allocateAmaMidpointUnits(codes.map((code, index) => timed(code!, minutes[index]!)));
    expect(result.lines.map((line) => line.units)).toEqual(units);
    expect(result.totalUnits).toBe(total);
    expect(result.totalTimedMinutes).toBe(minutes[0]! + minutes[1]!);
  });

  it("keeps untimed units independent, preserves output order, and flags zero timed minutes", () => {
    const result = allocateAmaMidpointUnits([
      timed("97530", 20),
      { cptCode: "97161", minutes: 0, timed: false },
      timed("97110", 0),
      timed("97110", 8),
    ]);
    expect(result.lines.map((line) => [line.cptCode, line.units, line.remainderMinutes])).toEqual([
      ["97530", 1, 5], ["97161", 1, 0], ["97110", 0, 0], ["97110", 1, 0],
    ]);
    expect(result).toMatchObject({
      totalTimedMinutes: 28, totalUnits: 3, unusedMinutes: 5,
      flags: [{ lineIndex: 2, cptCode: "97110", outcome: "FLAG", reason: "ZERO_MINUTES" }],
    });
  });

  it("handles empty input and allocates repeated equal lines deterministically without mutating inputs", () => {
    expect(allocateAmaMidpointUnits([])).toEqual({ lines: [], totalTimedMinutes: 0, totalUnits: 0, unusedMinutes: 0, flags: [] });
    const lines = Object.freeze([Object.freeze(timed("97110", 5)), Object.freeze(timed("97110", 5))]);
    const result = allocateAmaMidpointUnits(lines);
    expect(result.lines.map((line) => line.units)).toEqual([1, 0]);
    result.lines[0]!.minutes = 100;
    expect(allocateAmaMidpointUnits(lines).lines.map((line) => line.minutes)).toEqual([5, 5]);
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid minutes %s", (minutes) => {
    expect(() => allocateAmaMidpointUnits([timed("97110", minutes)])).toThrow(RangeError);
    expect(() => allocateAmaMidpointUnits([{ cptCode: "97161", minutes, timed: false }])).toThrow(RangeError);
  });

  it("rejects timed minute sums outside the safe integer range", () => {
    expect(() => allocateAmaMidpointUnits([timed("97110", Number.MAX_SAFE_INTEGER), timed("97530", 1)])).toThrow(RangeError);
  });
});
