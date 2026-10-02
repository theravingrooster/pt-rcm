import { describe, expect, it } from "vitest";
import {
  CptCodeSchema, getCarcFixture, getCptFixture, getModifierFixture,
  loadCarcFixtures, loadCptFixtures, loadMedicareMinuteLadder, loadModifierFixtures,
  MEDICARE_PT_SLP_KX_THRESHOLD_2026_CENTS, minutesToUnits,
} from "../index.js";

// CPT is an AMA-licensed code set. These assertions cover only the requested local test fixture.
describe("reference fixture accessors", () => {
  it("loads only the nine requested procedure codes and timing classifications", () => {
    expect(loadCptFixtures().map(({ code, timed }) => [code, timed])).toEqual([
      ["97161", false], ["97162", false], ["97163", false],
      ["97110", true], ["97112", true], ["97140", true],
      ["97530", true], ["97535", true], ["G0283", false],
    ]);
    expect(getCptFixture("G0283")?.codeSystem).toBe("HCPCS");
    expect(getCptFixture("G0283")?.name).toContain("Medicare");
  });

  it.each(loadCptFixtures())("looks up $code and accepts its canonical format", (row) => {
    expect(getCptFixture(row.code)).toEqual(row);
    expect(CptCodeSchema.parse(row.code)).toBe(row.code);
    expect(row.name.length).toBeGreaterThan(0);
  });

  it.each(["g0283", "G028", "G02833", "97A10", "9711", "971100"])("rejects malformed procedure code %s", (code) => {
    expect(CptCodeSchema.safeParse(code).success).toBe(false);
  });

  it("loads only the requested modifiers", () => {
    expect(loadModifierFixtures()).toEqual(["GP", "GO", "GN", "KX", "59", "XE", "XS", "XP", "XU", "CQ"]);
  });

  it.each(loadModifierFixtures())("looks up modifier %s", (modifier) => {
    expect(getModifierFixture(modifier)).toBe(modifier);
  });

  it("loads only the requested CARC names with plain-English meanings", () => {
    expect(loadCarcFixtures().map(({ name }) => name)).toEqual(["CO-4", "CO-16", "CO-197", "PR-1", "PR-2", "PR-3", "OA-23"]);
    for (const row of loadCarcFixtures()) {
      expect(Object.keys(row).sort()).toEqual(["meaning", "name"]);
      expect(row.meaning.length).toBeGreaterThan(0);
    }
  });

  it.each(loadCarcFixtures())("looks up CARC $name", (row) => {
    expect(getCarcFixture(row.name)).toEqual(row);
  });

  it("returns undefined for absent references without inventing data", () => {
    expect(getCptFixture("XXXXX")).toBeUndefined();
    expect(getModifierFixture("ZZ")).toBeUndefined();
    expect(getCarcFixture("CO-999")).toBeUndefined();
  });

  it("keeps shared reference data immutable across callers", () => {
    for (const rows of [loadCptFixtures(), loadCarcFixtures(), loadMedicareMinuteLadder()]) {
      expect(Object.isFrozen(rows)).toBe(true);
      expect(rows.every((row) => Object.isFrozen(row))).toBe(true);
    }
    expect(Object.isFrozen(loadModifierFixtures())).toBe(true);
  });
});

describe("Medicare fixture reference data", () => {
  it("loads the six inclusive minute brackets", () => {
    expect(loadMedicareMinuteLadder()).toEqual([
      { minMinutes: 0, maxMinutes: 7, units: 0 },
      { minMinutes: 8, maxMinutes: 22, units: 1 },
      { minMinutes: 23, maxMinutes: 37, units: 2 },
      { minMinutes: 38, maxMinutes: 52, units: 3 },
      { minMinutes: 53, maxMinutes: 67, units: 4 },
      { minMinutes: 68, maxMinutes: 82, units: 5 },
    ]);
  });

  it.each([
    [0, 0], [7, 0], [8, 1], [22, 1], [23, 2], [37, 2],
    [38, 3], [67, 4], [68, 5], [82, 5], [83, 6],
    [52, 3], [53, 4], [97, 6], [98, 7], [112, 7], [113, 8], [1000, 67],
  ])("converts %i timed minutes to %i units", (minutes, units) => {
    expect(minutesToUnits(minutes)).toBe(units);
  });

  it.each([-1, 0.5, 7.9, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid minute total %s", (minutes) => {
    expect(() => minutesToUnits(minutes)).toThrow(RangeError);
  });

  it("reuses an explicit Medicare ladder and extrapolates past its last bracket", () => {
    const shortLadder = loadMedicareMinuteLadder().slice(0, 2);
    expect(minutesToUnits(8, shortLadder)).toBe(1);
    expect(minutesToUnits(83, shortLadder)).toBe(6);
    const extendedLadder = [...loadMedicareMinuteLadder(), { minMinutes: 83, maxMinutes: 97, units: 6 }];
    expect(minutesToUnits(97, extendedLadder)).toBe(6);
    expect(minutesToUnits(98, extendedLadder)).toBe(7);
  });

  it.each([
    [],
    [{ minMinutes: 0, maxMinutes: 7, units: 0 }],
    [{ minMinutes: 0, maxMinutes: 7, units: 0 }, { minMinutes: 9, maxMinutes: 22, units: 1 }],
    [{ minMinutes: 0, maxMinutes: 7, units: 0 }, { minMinutes: 8, maxMinutes: 23, units: 1 }],
    [{ minMinutes: 0, maxMinutes: 7, units: 0 }, { minMinutes: 8, maxMinutes: 22, units: 2 }],
  ].map((ladder) => ({ ladder })))("rejects an incomplete or malformed supplied ladder %#", ({ ladder }) => {
    expect(() => minutesToUnits(0, ladder)).toThrow(RangeError);
  });

  it("stores the requested 2026 combined PT/SLP KX threshold in integer cents", () => {
    expect(MEDICARE_PT_SLP_KX_THRESHOLD_2026_CENTS).toBe(248000);
    expect(Number.isInteger(MEDICARE_PT_SLP_KX_THRESHOLD_2026_CENTS)).toBe(true);
  });
});
