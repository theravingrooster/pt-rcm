import { describe, expect, it } from "vitest";
import {
  allocateUnits, loadMedicareMinuteLadder, minutesToUnits, unitsLeftOnTable,
  type UnitAllocationInputLine,
} from "./index.js";

// CPT is an AMA-licensed code set; these are local test examples, not a CPT data file.
const ladder = loadMedicareMinuteLadder();
const timed = (cptCode: string, minutes: number): UnitAllocationInputLine => ({ cptCode, minutes, timed: true });

describe("allocateUnits", () => {
  it("perCodeRoundingWouldUnderbill", () => {
    const lines = [timed("97110", 20), timed("97530", 20)];
    expect(lines.reduce((sum, line) => sum + minutesToUnits(line.minutes), 0)).toBe(2);
    expect(allocateUnits(lines, ladder)).toEqual({
      lines: [
        { cptCode: "97110", minutes: 20, units: 2, remainderMinutes: 0 },
        { cptCode: "97530", minutes: 20, units: 1, remainderMinutes: 5 },
      ],
      totalTimedMinutes: 40, totalUnits: 3, unusedMinutes: 5, flags: [],
    });
  });

  it("pools 23 minutes of 97110 and 8 minutes of 97140 into two units", () => {
    expect(allocateUnits([timed("97110", 23), timed("97140", 8)], ladder)).toEqual({
      lines: [
        { cptCode: "97110", minutes: 23, units: 2, remainderMinutes: 0 },
        { cptCode: "97140", minutes: 8, units: 0, remainderMinutes: 8 },
      ],
      totalTimedMinutes: 31, totalUnits: 2, unusedMinutes: 8, flags: [],
    });
  });

  it("assigns by longest unassigned minutes, rather than repeatedly favoring the longest original line", () => {
    const result = allocateUnits([timed("97110", 32), timed("97530", 12)], ladder);
    // After two complete units, 97110 has 2 minutes left and 97530 has 12.
    // The remaining daily unit therefore belongs to 97530.
    expect(result.lines).toEqual([
      { cptCode: "97110", minutes: 32, units: 2, remainderMinutes: 2 },
      { cptCode: "97530", minutes: 12, units: 1, remainderMinutes: 0 },
    ]);
    expect(result.totalUnits).toBe(3);
    expect(result.unusedMinutes).toBe(2);
  });

  it("breaks ties by CPT ascending regardless of input order, preserving output order", () => {
    const result = allocateUnits([timed("97530", 20), timed("97110", 20)], ladder);
    expect(result.lines.map(({ cptCode, units }) => [cptCode, units])).toEqual([["97530", 1], ["97110", 2]]);
    // A tie after allocating a complete block uses CPT, not original duration.
    expect(allocateUnits([timed("97530", 23), timed("97110", 8)], ladder).lines.map((line) => line.units)).toEqual([1, 1]);
  });

  it("preserves complete blocks for every timed line before assigning fractional blocks", () => {
    const result = allocateUnits([timed("97110", 16), timed("97140", 16), timed("97530", 16)], ladder);
    expect(result.lines.map((line) => line.units)).toEqual([1, 1, 1]);
    expect(result.totalUnits).toBe(3);
    expect(result.unusedMinutes).toBe(3);
  });

  it.each(["97161", "97162", "97163", "G0283"])("gives present untimed %s one independent unit, even at zero minutes", (cptCode) => {
    for (const minutes of [0, 30]) {
      const result = allocateUnits([{ cptCode, minutes, timed: false }, timed("97110", 7)], ladder);
      expect(result.lines).toEqual([
        { cptCode, minutes, units: 1, remainderMinutes: 0 },
        { cptCode: "97110", minutes: 7, units: 0, remainderMinutes: 7 },
      ]);
      expect(result).toMatchObject({ totalTimedMinutes: 7, totalUnits: 1, unusedMinutes: 7, flags: [] });
    }
  });

  it("keeps untimed units separate from the daily timed budget in mixed inputs", () => {
    const result = allocateUnits([
      { cptCode: "97161", minutes: 30, timed: false },
      timed("97110", 20), timed("97530", 20),
      { cptCode: "G0283", minutes: 10, timed: false },
    ], ladder);
    expect(result.totalTimedMinutes).toBe(40);
    expect(result.lines.map((line) => line.units)).toEqual([1, 2, 1, 1]);
    expect(result.totalUnits).toBe(5);
    expect(result.unusedMinutes).toBe(5);
  });

  it("preserves and flags every zero-minute timed line without allocating to it", () => {
    const result = allocateUnits([timed("97110", 0), timed("97530", 8), timed("97140", 0)], ladder);
    expect(result.lines.map((line) => line.units)).toEqual([0, 1, 0]);
    expect(result.flags).toEqual([
      { lineIndex: 0, cptCode: "97110", outcome: "FLAG", reason: "ZERO_MINUTES" },
      { lineIndex: 2, cptCode: "97140", outcome: "FLAG", reason: "ZERO_MINUTES" },
    ]);
    expect(result.totalUnits).toBe(1);
    expect(result.unusedMinutes).toBe(0);
  });

  it("does not exceed the pooled budget even when each remainder alone meets eight minutes", () => {
    const result = allocateUnits([timed("97110", 8), timed("97530", 8)], ladder);
    expect(result.lines.map((line) => line.units)).toEqual([1, 0]);
    expect(result.totalUnits).toBe(1);
    expect(result.unusedMinutes).toBe(8);
  });

  it("handles empty and all-zero timed inputs", () => {
    expect(allocateUnits([], ladder)).toEqual({ lines: [], totalTimedMinutes: 0, totalUnits: 0, unusedMinutes: 0, flags: [] });
    const result = allocateUnits([timed("97110", 0), timed("97530", 0)], ladder);
    expect(result.lines.map((line) => line.units)).toEqual([0, 0]);
    expect(result.flags).toHaveLength(2);
    expect(result).toMatchObject({ totalUnits: 0, totalTimedMinutes: 0, unusedMinutes: 0 });
  });

  it.each([
    [0, 0], [7, 0], [8, 1], [22, 1], [23, 2], [37, 2], [38, 3],
    [67, 4], [68, 5], [82, 5], [83, 6], [98, 7], [1000, 67],
  ])("allocates a single %i-minute line as %i units, including beyond the table", (minutes, units) => {
    const result = allocateUnits([timed("97110", minutes)], ladder);
    expect(result.totalUnits).toBe(units);
    expect(result.lines[0]).toEqual({ cptCode: "97110", minutes, units, remainderMinutes: Math.max(0, minutes - units * 15) });
  });

  it("does not mutate frozen inputs or ladder data and keeps duplicate lines stable", () => {
    const lines = Object.freeze([Object.freeze(timed("97110", 4)), Object.freeze(timed("97110", 4))]);
    const result = allocateUnits(lines, ladder);
    expect(result.lines.map((line) => line.units)).toEqual([1, 0]);
    result.lines[0]!.minutes = 100;
    expect(lines.map((line) => line.minutes)).toEqual([4, 4]);
    expect(allocateUnits(lines, ladder).lines.map((line) => line.minutes)).toEqual([4, 4]);
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid minutes %s without coercing them", (minutes) => {
    expect(() => allocateUnits([timed("97110", minutes)], ladder)).toThrow(RangeError);
    expect(() => allocateUnits([{ cptCode: "97161", minutes, timed: false }], ladder)).toThrow(RangeError);
  });

  it("rejects unsafe summed minutes", () => {
    expect(() => allocateUnits([timed("97110", Number.MAX_SAFE_INTEGER), timed("97530", 1)], ladder)).toThrow(RangeError);
  });

  it("uses and validates the supplied ladder", () => {
    expect(allocateUnits([timed("97110", 83)], ladder.slice(0, 2)).totalUnits).toBe(6);
    expect(() => allocateUnits([timed("97110", 20)], [])).toThrow(RangeError);
    expect(() => allocateUnits([timed("97110", 20)], [{ minMinutes: 0, maxMinutes: 7, units: 0 }, { minMinutes: 8, maxMinutes: 22, units: 2 }])).toThrow(RangeError);
  });

  it("matches minutesToUnits(sum) for seeded random timed lines: 0..60 minutes and 2..4 codes", () => {
    const codes = ["97110", "97112", "97140", "97530"];
    // Deterministic pseudo-random samples keep failures reproducible.
    let state = 0x8_15_2026;
    const randomInt = (max: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % max;
    };
    for (let sample = 0; sample < 1000; sample++) {
      const lines = codes.slice(0, 2 + randomInt(3)).map((code) => timed(code, randomInt(61)));
      const before = structuredClone(lines);
      const result = allocateUnits(lines, ladder);
      const total = lines.reduce((sum, line) => sum + line.minutes, 0);
      const context = JSON.stringify(lines);
      expect(result.totalTimedMinutes, context).toBe(total);
      expect(result.totalUnits, context).toBe(minutesToUnits(total));
      expect(result.lines.reduce((sum, line) => sum + line.units, 0), context).toBe(result.totalUnits);
      expect(result.unusedMinutes, context).toBe(result.lines.reduce((sum, line) => sum + line.remainderMinutes, 0));
      result.lines.forEach((line, index) => {
        expect(line.minutes, context).toBe(lines[index]!.minutes);
        expect(line.units, context).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(line.units), context).toBe(true);
        expect(line.remainderMinutes, context).toBe(Math.max(0, line.minutes - 15 * line.units));
        if (line.minutes === 0) expect(line.units, context).toBe(0);
      });
      const reversed = allocateUnits([...lines].reverse(), ladder);
      expect(reversed.lines.reverse(), context).toEqual(result.lines);
      expect(unitsLeftOnTable(lines), context).toBeGreaterThanOrEqual(0);
      expect(lines, context).toEqual(before);
    }
  });
});

describe("unitsLeftOnTable", () => {
  it.each([
    [[20, 20], 1], [[23, 8], 0], [[8, 8], 0], [[7, 7], 1],
    [[0, 0], 0], [[60, 60], 0],
  ] as const)("compares per-code rounding for %j minutes: %i units left", (minutes, expected) => {
    expect(unitsLeftOnTable([timed("97110", minutes[0]), timed("97530", minutes[1])])).toBe(expected);
  });
  it("compares per CPT, combining repeated timed codes", () => {
    expect(unitsLeftOnTable([timed("97110", 20), timed("97110", 20)])).toBe(0);
  });
  it("does not count untimed units as lost units", () => {
    const untimed = { cptCode: "97161", minutes: 30, timed: false };
    expect(unitsLeftOnTable([])).toBe(0);
    expect(unitsLeftOnTable([untimed])).toBe(0);
    expect(unitsLeftOnTable([untimed, timed("97110", 20), timed("97530", 20)])).toBe(1);
  });
  it("rejects invalid input rather than fabricating a comparison", () => {
    expect(() => unitsLeftOnTable([timed("97110", -1)])).toThrow(RangeError);
  });
});
