import { describe, expect, it } from "vitest";
import { fixtureLineChargeCents, PT_FIXTURE_FEES_CENTS } from "./fees.js";

describe("local fixture fee schedule (integer cents)", () => {
  it.each([
    ["97161", 1, 12000], ["97162", 1, 12000], ["97163", 1, 12000],
    ["97110", 2, 9000], ["97112", 1, 4500], ["97140", 1, 4500],
    ["97530", 1, 4500], ["97535", 1, 4500], ["G0283", 1, 2000], ["97110", 0, 0],
  ])("%s x %i costs %i cents", (code, units, cents) => {
    expect(fixtureLineChargeCents(code as string, units as number)).toBe(cents);
  });
  it.each(["99999", "toString", "__proto__"])("rejects unknown code %s", (code) => {
    expect(() => fixtureLineChargeCents(code, 1)).toThrow(RangeError);
  });
  it.each([-1, 1.5, NaN, Infinity, 500000])("rejects invalid units or cent overflow %s", (units) => {
    expect(() => fixtureLineChargeCents("97110", units)).toThrow();
  });
  it("exports immutable data", () => { expect(Object.isFrozen(PT_FIXTURE_FEES_CENTS)).toBe(true); });
});
