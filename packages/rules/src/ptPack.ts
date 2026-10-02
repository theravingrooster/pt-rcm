import { allocateUnits, loadMedicareMinuteLadder, MEDICARE_PT_SLP_KX_THRESHOLD_2026_CENTS, unitsLeftOnTable } from "@pt-rcm/domain";
import type { Rule, RuleResult } from "./types.js";

// CPT is an AMA-licensed code set. These local fixture codes are not a
// redistribution of the CPT data file. This is the requested prototype policy.
const ptCodes = new Set(["97161", "97162", "97163", "97110", "97112", "97140", "97530", "97535"]);
const evalCodes = new Set(["97161", "97162", "97163"]);
const distinctModifiers = new Set(["59", "XE", "XP", "XS", "XU"]);
const ELIGIBILITY_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export const coverageInactiveRule: Rule = Object.freeze<Rule>({
  id: "coverage-inactive", version: 1, description: "Review the most recent eligibility check before submission.",
  evaluate(ctx): RuleResult {
    const checkedAt = ctx.coverage?.checkedAt;
    if (!checkedAt) return { outcome: "FLAG", code: "ELIGIBILITY_NOT_RUN", message: "No eligibility check is recorded for this coverage." };
    const ageMs = Date.parse(ctx.evaluationTime) - Date.parse(checkedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= ELIGIBILITY_FRESH_MS) {
      return { outcome: "FLAG", code: "ELIGIBILITY_STALE", message: "The latest eligibility check is at least seven days old or outside the current evaluation period.", detail: { checkedAt } };
    }
    if (ctx.coverage?.eligible === false) {
      return { outcome: "BLOCK", code: "COVERAGE_INACTIVE", message: "The most recent eligibility check reports inactive coverage.", detail: { checkedAt } };
    }
    if (ctx.coverage?.eligible !== true) {
      return { outcome: "FLAG", code: "ELIGIBILITY_NOT_RUN", message: "No complete eligibility result is recorded for this coverage." };
    }
    return { outcome: "PASS" };
  },
});

export const gpModifierRule: Rule = Object.freeze<Rule>({
  id: "gp-modifier", version: 1, description: "Add GP to PT lines when the payer requires it.",
  evaluate(ctx): RuleResult {
    if (!ctx.payer.requiresGpModifier) return { outcome: "PASS" };
    const linePatches = ctx.draftClaim.lines.flatMap((line, lineIndex) =>
      ptCodes.has(line.cptCode) && !line.modifiers.includes("GP") ? [{ lineIndex, addModifiers: ["GP" as const] }] : []);
    return linePatches.length ? { outcome: "DOWNGRADE", code: "MISSING_GP", message: "Add GP to the indicated PT lines.", linePatches } : { outcome: "PASS" };
  },
});

export const eightMinuteAppliedRule: Rule = Object.freeze<Rule>({
  id: "eight-minute-applied", version: 1, description: "Compare submitted timed units with allocation from the daily timed total.",
  evaluate(ctx): RuleResult {
    const allocation = allocateUnits(ctx.minuteLines, loadMedicareMinuteLadder());
    if (ctx.draftClaim.lines.length !== allocation.lines.length || ctx.draftClaim.lines.some((line, index) =>
      line.cptCode !== allocation.lines[index]!.cptCode || line.minutes !== allocation.lines[index]!.minutes)) {
      return { outcome: "BLOCK", code: "DRAFT_LINES_MISMATCH", message: "Draft lines must match the recorded encounter lines." };
    }
    const over: number[] = [];
    const under: number[] = [];
    ctx.draftClaim.lines.forEach((line, index) => {
      if (!ctx.minuteLines[index]!.timed) return;
      if (line.units > allocation.lines[index]!.units) over.push(index);
      if (line.units < allocation.lines[index]!.units) under.push(index);
    });
    if (over.length) return { outcome: "BLOCK", code: "OVERBILLED_UNITS", message: "Submitted timed units exceed the allocated units.", detail: { lineIndexes: over } };
    if (under.length) return { outcome: "FLAG", code: "UNDERBILLED_UNITS", message: "Submitted timed units are below allocation; review without automatically increasing units.", detail: { lineIndexes: under, unitsLeftOnTable: unitsLeftOnTable(ctx.minuteLines) } };
    return { outcome: "PASS" };
  },
});

export const zeroMinuteTimedRule: Rule = Object.freeze<Rule>({
  id: "zero-minute-timed", version: 1, description: "Block recorded timed services with zero minutes.",
  evaluate(ctx): RuleResult {
    const lineIndexes = ctx.minuteLines.flatMap((line, index) => line.timed && line.minutes === 0 ? [index] : []);
    return lineIndexes.length ? { outcome: "BLOCK", code: "ZERO_MINUTES", message: "A timed service has zero recorded minutes.", detail: { lineIndexes } } : { outcome: "PASS" };
  },
});

export const kxThresholdRule: Rule = Object.freeze<Rule>({
  id: "kx-threshold", version: 1, description: "Check KX against the fixture Medicare PT/SLP threshold.",
  evaluate(ctx): RuleResult {
    if (ctx.payer.payerType !== "MEDICARE") return { outcome: "PASS" };
    const projectedCents = ctx.yearToDateBilledCents + ctx.claimChargeCents;
    const thresholdCents = MEDICARE_PT_SLP_KX_THRESHOLD_2026_CENTS;
    const lines = ctx.draftClaim.lines.filter((line) => line.units > 0);
    // KX also requires documentation of medical necessity, which this prototype
    // does not check. Never add KX automatically, even above the threshold.
    if (projectedCents > thresholdCents && lines.some((line) => !line.modifiers.includes("KX"))) {
      return { outcome: "BLOCK", code: "MISSING_KX", message: "KX is missing above the fixture Medicare PT/SLP threshold.", detail: { projectedCents, thresholdCents } };
    }
    if (projectedCents < thresholdCents && lines.some((line) => line.modifiers.includes("KX"))) {
      return { outcome: "FLAG", code: "KX_NOT_REQUIRED", message: "KX is present below the fixture threshold.", detail: { projectedCents, thresholdCents } };
    }
    return { outcome: "PASS" };
  },
});

export const authVisitsRule: Rule = Object.freeze<Rule>({
  id: "auth-visits", version: 1, description: "Check the linked authorization's recorded visit use.",
  evaluate(ctx): RuleResult {
    if (!ctx.encounter.authorizationId) {
      return ctx.payer.payerType === "COMMERCIAL" ? { outcome: "FLAG", code: "AUTH_NOT_LINKED", message: "No authorization is linked for the commercial payer." } : { outcome: "PASS" };
    }
    const authorization = ctx.authorizations.find((auth) => auth.id === ctx.encounter.authorizationId
      && auth.patientId === ctx.encounter.patientId && auth.payerId === ctx.payer.id);
    if (!authorization) return { outcome: "BLOCK", code: "AUTH_NOT_FOUND", message: "The linked authorization is unavailable for this patient and payer." };
    return authorization.visitsUsed >= authorization.visitsAuthorized ? { outcome: "BLOCK", code: "AUTH_EXHAUSTED", message: "The linked authorization has no remaining visits." } : { outcome: "PASS" };
  },
});

export const planOfCareRule: Rule = Object.freeze<Rule>({
  id: "plan-of-care", version: 1, description: "Require a signed, unexpired plan of care on the service date.",
  evaluate(ctx): RuleResult {
    const plan = ctx.planOfCare;
    if (!plan) return { outcome: "BLOCK", code: "POC_INVALID", message: "A plan of care is missing." };
    const defaultExpiry = new Date(`${plan.signedDate}T00:00:00.000Z`);
    defaultExpiry.setUTCDate(defaultExpiry.getUTCDate() + 90);
    const expiresOn = plan.expiresOn ?? defaultExpiry.toISOString().slice(0, 10);
    if (plan.patientId !== ctx.encounter.patientId || plan.signedDate > ctx.encounter.dateOfService || ctx.encounter.dateOfService > expiresOn) {
      return { outcome: "BLOCK", code: "POC_INVALID", message: "The plan of care is not valid on the service date.", detail: { signedDate: plan.signedDate, expiresOn } };
    }
    return { outcome: "PASS" };
  },
});

export const evalWithTreatmentRule: Rule = Object.freeze<Rule>({
  id: "eval-with-treatment", version: 1, description: "Flag an evaluation and timed treatment on the same service day.",
  evaluate(ctx): RuleResult {
    return ctx.minuteLines.some((line) => evalCodes.has(line.cptCode)) && ctx.minuteLines.some((line) => line.timed)
      ? { outcome: "FLAG", code: "EVAL_PLUS_TREAT", message: "Evaluation and timed treatment are both present; review both lines." } : { outcome: "PASS" };
  },
});

export const distinctProcedureRule: Rule = Object.freeze<Rule>({
  id: "distinct-procedure", version: 1, description: "Flag pairs of different timed codes with no supplied distinct-procedure modifier.",
  evaluate(ctx): RuleResult {
    const unmarkedCodes = new Set(ctx.draftClaim.lines.filter((line, index) => ctx.minuteLines[index]?.timed
      && !line.modifiers.some((modifier) => distinctModifiers.has(modifier))).map((line) => line.cptCode));
    return unmarkedCodes.size >= 2 ? { outcome: "FLAG", code: "MISSING_59", message: "Two timed procedures have neither 59 nor an XE/XP/XS/XU modifier; review without adding one automatically." } : { outcome: "PASS" };
  },
});

export const timedCodeCapRule: Rule = Object.freeze<Rule>({
  id: "timed-code-cap", version: 1, description: "Flag more than four billed units for one timed CPT code.",
  evaluate(ctx): RuleResult {
    const unitsByCode = new Map<string, number>();
    ctx.draftClaim.lines.forEach((line, index) => {
      const recorded = ctx.minuteLines[index];
      if (!recorded?.timed || recorded.cptCode !== line.cptCode) return;
      unitsByCode.set(line.cptCode, (unitsByCode.get(line.cptCode) ?? 0) + line.units);
    });
    const cappedCodes = [...unitsByCode].filter(([, units]) => units > 4).map(([code]) => code).sort();
    return cappedCodes.length
      ? { outcome: "FLAG", code: "TIMED_CODE_CAP", message: "A timed code has more than four billed units; review the recorded services.",
        detail: { cptCodes: cappedCodes, capUnits: 4 } }
      : { outcome: "PASS" };
  },
});

export const ptPack = Object.freeze({
  id: "outpatient-pt", version: 1, mode: "active" as const,
  rules: Object.freeze([gpModifierRule, eightMinuteAppliedRule, zeroMinuteTimedRule, kxThresholdRule,
    authVisitsRule, planOfCareRule, evalWithTreatmentRule, distinctProcedureRule]),
});
