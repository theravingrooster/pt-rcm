import { describe, expect, it } from "vitest";
import { allocateUnits, fixtureLineChargeCents, getCptFixture, loadMedicareMinuteLadder } from "@pt-rcm/domain";
import { applyDowngrades, runRules, toRuleFireRows } from "./index.js";
import { authVisitsRule, distinctProcedureRule, eightMinuteAppliedRule, evalWithTreatmentRule, gpModifierRule, kxThresholdRule, planOfCareRule, ptPack, timedCodeCapRule, zeroMinuteTimedRule } from "./ptPack.js";
import { makeContext, testClaimId } from "./testing/fixtures.js";
import type { RuleContext } from "./types.js";

type Line = { cptCode: string; minutes: number; units?: number; modifiers?: string[] };
function context(lines: Line[] = [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }]): RuleContext {
  const base = makeContext();
  const minuteLines = lines.map((line, index) => ({ id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, encounterId: base.encounter.id,
    cptCode: line.cptCode, minutes: line.minutes, timed: getCptFixture(line.cptCode)!.timed, notes: null }));
  const allocatedUnits = allocateUnits(minuteLines, loadMedicareMinuteLadder());
  const draftClaim = { encounterId: base.encounter.id, lines: allocatedUnits.lines.map((line, index) => ({
    cptCode: line.cptCode, minutes: line.minutes, units: lines[index]!.units ?? line.units,
    modifiers: lines[index]!.modifiers ?? [], diagnosisPointers: [0],
  })) };
  return { ...base, minuteLines, allocatedUnits, draftClaim,
    claimChargeCents: draftClaim.lines.reduce((sum, line) => sum + fixtureLineChargeCents(line.cptCode, line.units), 0),
    payer: { ...base.payer, payerType: "MEDICARE", requiresGpModifier: true }, yearToDateBilledCents: 0,
    planOfCare: { id: testClaimId, patientId: base.encounter.patientId, signedDate: "2026-09-25", certifyingNpi: "0000000004", expiresOn: null } };
}

describe("gp-modifier", () => {
  it.each(["97161", "97162", "97163", "97110", "97112", "97140", "97530", "97535"])("adds only GP to %s without changing clinical facts or units", (cptCode) => {
    const ctx = context([{ cptCode, minutes: 20, modifiers: ["59"] }]);
    const before = structuredClone(ctx);
    const run = runRules([gpModifierRule], ctx);
    expect(run.downgrades[0]).toMatchObject({ code: "MISSING_GP", linePatches: [{ lineIndex: 0, addModifiers: ["GP"] }] });
    const applied = applyDowngrades(ctx.draftClaim, run.downgrades);
    expect(applied.lines[0]).toEqual({ ...ctx.draftClaim.lines[0], modifiers: ["59", "GP"] });
    expect(applyDowngrades(applied, run.downgrades)).toEqual(applied);
    expect(ctx).toEqual(before);
  });
  it.each([
    ["97110", ["GP"], true], ["G0283", [], true], ["97110", [], false],
  ] as const)("passes %s with modifiers %j and requiresGP=%s", (cptCode, modifiers, requiresGpModifier) => {
    const ctx = context([{ cptCode, minutes: 20, modifiers: [...modifiers] }]);
    expect(gpModifierRule.evaluate({ ...ctx, payer: { ...ctx.payer, requiresGpModifier } })).toEqual({ outcome: "PASS" });
  });
  it.each(["KX", "59", "GO", "GN"])("runtime rejects an automatic %s addition", (modifier) => {
    const unsafe = { ...gpModifierRule, evaluate: () => ({ outcome: "DOWNGRADE", code: "UNSAFE", message: "Unsafe fixture", linePatches: [{ lineIndex: 0, addModifiers: [modifier] }] }) };
    expect(runRules([unsafe as typeof gpModifierRule], context()).blocks[0]).toMatchObject({ code: "RULE_CRASH" });
  });
});

describe("eight-minute-applied", () => {
  it.each([
    { units: [2, 1], outcome: "PASS", code: undefined },
    { units: [3, 1], outcome: "BLOCK", code: "OVERBILLED_UNITS" },
    { units: [1, 1], outcome: "FLAG", code: "UNDERBILLED_UNITS" },
    { units: [1, 2], outcome: "BLOCK", code: "OVERBILLED_UNITS" },
  ])("submitted $units produces $outcome $code", ({ units, outcome, code }) => {
    const ctx = context([{ cptCode: "97110", minutes: 20, units: units[0]! }, { cptCode: "97530", minutes: 20, units: units[1]! }]);
    const before = structuredClone(ctx);
    const result = eightMinuteAppliedRule.evaluate(ctx);
    expect(result).toMatchObject(code ? { outcome, code } : { outcome });
    if (outcome === "FLAG") {
      expect(result).toMatchObject({ detail: { unitsLeftOnTable: 1 } });
      expect(toRuleFireRows(testClaimId, runRules([eightMinuteAppliedRule], ctx))[0]!.detailJson).toMatchObject({ unitsLeftOnTable: 1 });
    }
    expect(ctx).toEqual(before);
  });
  it.each([
    [{ cptCode: "97110", minutes: 23 }, { cptCode: "97140", minutes: 8 }],
    [{ cptCode: "97161", minutes: 0 }, { cptCode: "97110", minutes: 0 }],
  ])("uses the existing allocation, including untimed and zero-unit lines %#", (...lines) => {
    expect(eightMinuteAppliedRule.evaluate(context(lines))).toEqual({ outcome: "PASS" });
  });
  it("blocks mismatched draft services rather than comparing unrelated lines", () => {
    const ctx = context();
    expect(eightMinuteAppliedRule.evaluate({ ...ctx, draftClaim: { ...ctx.draftClaim, lines: [] } })).toMatchObject({ outcome: "BLOCK", code: "DRAFT_LINES_MISMATCH" });
  });
});

describe("zero-minute-timed", () => {
  it.each([
    ["97110", 0, "BLOCK"], ["97530", 1, "PASS"], ["97110", 8, "PASS"], ["97161", 0, "PASS"], ["G0283", 0, "PASS"],
  ] as const)("%s with %i minutes => %s", (cptCode, minutes, outcome) => {
    expect(zeroMinuteTimedRule.evaluate(context([{ cptCode, minutes }]))).toEqual(outcome === "BLOCK"
      ? expect.objectContaining({ outcome, code: "ZERO_MINUTES" }) : { outcome });
  });
});

describe("kx-threshold", () => {
  it.each([
    [247999, false, "PASS", undefined], [247999, true, "FLAG", "KX_NOT_REQUIRED"],
    [248000, false, "PASS", undefined], [248000, true, "PASS", undefined],
    [248001, false, "BLOCK", "MISSING_KX"], [248001, true, "PASS", undefined],
  ] as const)("projected %i cents, KX=%s => %s", (projected, kx, outcome, code) => {
    const ctx = context([{ cptCode: "97110", minutes: 8, modifiers: kx ? ["KX"] : [] }]);
    expect(kxThresholdRule.evaluate({ ...ctx, yearToDateBilledCents: projected - ctx.claimChargeCents })).toMatchObject(code ? { outcome, code } : { outcome });
  });
  it.each([0, 300000])("does not apply the Medicare threshold to a commercial payer at %i cents", (yearToDateBilledCents) => {
    const ctx = context([{ cptCode: "97110", minutes: 8, modifiers: ["KX"] }]);
    expect(kxThresholdRule.evaluate({ ...ctx, yearToDateBilledCents, payer: { ...ctx.payer, payerType: "COMMERCIAL" } })).toEqual({ outcome: "PASS" });
  });
  it("requires KX on every billed line above threshold without proposing it", () => {
    const ctx = context([{ cptCode: "97110", minutes: 20, modifiers: ["KX"] }, { cptCode: "97530", minutes: 20 }]);
    const run = runRules([kxThresholdRule], { ...ctx, yearToDateBilledCents: 240000 });
    expect(run.blocks[0]).toMatchObject({ code: "MISSING_KX" });
    expect(run.downgrades).toEqual([]);
  });
});

describe("auth-visits", () => {
  it.each([["MEDICARE", "PASS"], ["COMMERCIAL", "FLAG"]] as const)("unlinked %s => %s", (payerType, outcome) => {
    const ctx = context();
    expect(authVisitsRule.evaluate({ ...ctx, payer: { ...ctx.payer, payerType } })).toMatchObject(outcome === "FLAG" ? { outcome, code: "AUTH_NOT_LINKED" } : { outcome });
  });
  it.each([[0, 1, "PASS"], [1, 1, "BLOCK"], [2, 1, "BLOCK"], [0, 0, "BLOCK"]] as const)("%i used / %i authorized => %s", (visitsUsed, visitsAuthorized, outcome) => {
    const ctx = context();
    const auth = { id: testClaimId, patientId: ctx.encounter.patientId, payerId: ctx.payer.id, cptFamily: "SYN-PT", visitsUsed, visitsAuthorized, startDate: "2026-01-01", endDate: "2026-12-31" };
    expect(authVisitsRule.evaluate({ ...ctx, encounter: { ...ctx.encounter, authorizationId: auth.id }, authorizations: [auth] })).toMatchObject(outcome === "BLOCK" ? { outcome, code: "AUTH_EXHAUSTED" } : { outcome });
  });
  it("does not accept a missing linked record", () => {
    const ctx = context();
    expect(authVisitsRule.evaluate({ ...ctx, encounter: { ...ctx.encounter, authorizationId: testClaimId } })).toMatchObject({ outcome: "BLOCK", code: "AUTH_NOT_FOUND" });
  });
});

describe("plan-of-care", () => {
  it.each([
    [null, null, "2026-10-01", "BLOCK"],
    ["2026-10-02", null, "2026-10-01", "BLOCK"],
    ["2026-10-01", "2026-10-01", "2026-10-01", "PASS"],
    ["2026-09-01", "2026-09-30", "2026-10-01", "BLOCK"],
    ["2026-09-01", "2026-10-01", "2026-10-01", "PASS"],
    ["2026-07-03", null, "2026-10-01", "PASS"],
    ["2026-07-02", null, "2026-10-01", "BLOCK"],
    ["2024-01-01", null, "2024-03-31", "PASS"],
    ["2024-01-01", null, "2024-04-01", "BLOCK"],
    ["2025-12-01", null, "2026-03-01", "PASS"],
  ] as const)("signed %s, expires %s, service %s => %s", (signedDate, expiresOn, dateOfService, outcome) => {
    const ctx = context();
    const planOfCare = signedDate ? { ...ctx.planOfCare!, signedDate, expiresOn } : null;
    const input = { ...ctx, encounter: { ...ctx.encounter, dateOfService }, planOfCare };
    const before = structuredClone(input);
    expect(planOfCareRule.evaluate(input)).toMatchObject(outcome === "BLOCK" ? { outcome, code: "POC_INVALID" } : { outcome });
    expect(input).toEqual(before);
  });
});

describe("eval-with-treatment", () => {
  it.each(["97161", "97162", "97163"])("flags %s plus timed treatment without dropping either line", (cptCode) => {
    const ctx = context([{ cptCode, minutes: 0 }, { cptCode: "97110", minutes: 8 }]);
    const run = runRules([evalWithTreatmentRule], ctx);
    expect(run.findings[0]).toMatchObject({ outcome: "FLAG", code: "EVAL_PLUS_TREAT" });
    expect(run.submissionAllowed).toBe(true);
    expect(applyDowngrades(ctx.draftClaim, run.downgrades)).toEqual(ctx.draftClaim);
  });
  it.each(["97161", "97110", "G0283"])("passes a lone %s", (cptCode) => {
    expect(evalWithTreatmentRule.evaluate(context([{ cptCode, minutes: 8 }]))).toEqual({ outcome: "PASS" });
  });
});

describe("distinct-procedure", () => {
  it.each([
    [[], "FLAG"], [["GP"], "FLAG"], [["KX", "GO", "GN"], "FLAG"],
    [["59"], "PASS"], [["XE"], "PASS"], [["XP"], "PASS"], [["XS"], "PASS"], [["XU"], "PASS"],
  ] as const)("one of two timed lines has %j => %s", (modifiers, outcome) => {
    const ctx = context([{ cptCode: "97110", minutes: 20, modifiers: [...modifiers] }, { cptCode: "97530", minutes: 20 }]);
    expect(distinctProcedureRule.evaluate(ctx)).toMatchObject(outcome === "FLAG" ? { outcome, code: "MISSING_59" } : { outcome });
  });
  it.each(["97161", "G0283", "97110"])("a timed line plus %s does not form two distinct timed codes", (cptCode) => {
    expect(distinctProcedureRule.evaluate(context([{ cptCode: "97110", minutes: 15 }, { cptCode, minutes: 15 }]))).toEqual({ outcome: "PASS" });
  });
  it("still flags an unmarked pair among three codes", () => {
    expect(distinctProcedureRule.evaluate(context([{ cptCode: "97110", minutes: 15, modifiers: ["59"] }, { cptCode: "97140", minutes: 15 }, { cptCode: "97530", minutes: 15 }]))).toMatchObject({ outcome: "FLAG", code: "MISSING_59" });
  });
});

describe("timed-code-cap", () => {
  it.each([
    { lines: [{ cptCode: "97110", minutes: 53, units: 4 }], outcome: "PASS" },
    { lines: [{ cptCode: "97110", minutes: 68, units: 5 }], outcome: "FLAG" },
    { lines: [{ cptCode: "97110", minutes: 38, units: 3 }, { cptCode: "97110", minutes: 23, units: 2 }], outcome: "FLAG" },
    { lines: [{ cptCode: "97110", minutes: 38, units: 3 }, { cptCode: "97530", minutes: 23, units: 2 }], outcome: "PASS" },
    { lines: [{ cptCode: "97161", minutes: 0, units: 5 }], outcome: "PASS" },
  ])("$lines => $outcome", ({ lines, outcome }) => {
    const ctx = context(lines);
    const before = structuredClone(ctx);
    expect(timedCodeCapRule.evaluate(ctx)).toMatchObject(outcome === "FLAG"
      ? { outcome, code: "TIMED_CODE_CAP", detail: { cptCodes: ["97110"], capUnits: 4 } }
      : { outcome });
    expect(ctx).toEqual(before);
  });

  it("does not treat a mismatched draft code as a recorded timed service", () => {
    const ctx = context([{ cptCode: "97161", minutes: 0, units: 5 }]);
    const draftClaim = { ...ctx.draftClaim, lines: [{ ...ctx.draftClaim.lines[0]!, cptCode: "97110" }] };
    expect(timedCodeCapRule.evaluate({ ...ctx, draftClaim })).toEqual({ outcome: "PASS" });
  });
});

it("the complete pack stays pure and shadow proposals cannot apply GP or block", () => {
  const ctx = { ...context(), planOfCare: null, mode: "shadow" as const };
  const before = structuredClone(ctx);
  const run = runRules(ptPack.rules, ctx);
  expect(run.findings).toHaveLength(8);
  expect(run.findings.every((finding) => finding.shadow)).toBe(true);
  expect(run.submissionAllowed).toBe(true);
  expect(applyDowngrades(ctx.draftClaim, run.downgrades)).toEqual(ctx.draftClaim);
  expect(ctx).toEqual(before);
});
