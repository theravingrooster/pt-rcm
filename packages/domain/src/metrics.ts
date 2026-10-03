import { z } from "zod";
import { allocateAmaMidpointUnits } from "./amaMidpoint.js";
import { allocateUnits } from "./eightMinute.js";
import { getCptFixture } from "./fixtures/cpt.js";
import { PT_FIXTURE_FEES_CENTS } from "./fixtures/fees.js";
import { loadMedicareMinuteLadder } from "./fixtures/medicare.js";
import { ClaimStatusSchema, CptCodeSchema, MoneyCentsSchema, NonNegativeIntSchema, PayerTypeSchema, UnitRuleSchema } from "./models.js";

export const MetricMinuteLinesSchema = z.array(z.object({
  cptCode: CptCodeSchema, minutes: NonNegativeIntSchema, timed: z.boolean(),
}).passthrough());

export const MetricClaimSchema = z.object({
  status: ClaimStatusSchema,
  payerType: PayerTypeSchema,
  unitRule: UnitRuleSchema,
  everSubmitted: z.boolean(),
  operatorTaskEverOpened: z.boolean(),
  totalChargeCents: MoneyCentsSchema,
  // null means the claim has no saved, successful scrub to compare with billing.
  minuteLines: MetricMinuteLinesSchema.nullable(),
  billedLines: z.array(z.object({ cptCode: CptCodeSchema, units: NonNegativeIntSchema }).strict()),
  // These are matched receipts for the current claim version only.
  remits: z.array(z.object({
    paidCents: MoneyCentsSchema,
    patientResponsibilityCents: MoneyCentsSchema,
    contractualWriteOffCents: MoneyCentsSchema,
  }).strict()),
}).strict();
export type MetricClaim = z.infer<typeof MetricClaimSchema>;

const scrubbedStatuses = new Set(["SCRUBBED", "SUBMITTED", "ACCEPTED", "REJECTED", "PAID", "DENIED", "PATIENT_BALANCE"]);
export const TIMED_UNIT_FIXTURE_FEE_CENTS = PT_FIXTURE_FEES_CENTS["97110"]!;

function safeSum(values: readonly number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("Metric total exceeds the safe integer range");
  return total;
}

/** Ratios are null when their denominator is zero. Touchless uses every claim
 * in the supplied set; denial uses claims ever submitted, including a rejected
 * claim returned to DRAFT. Counts use current statuses and all historical tasks.
 *
 * Net collection = payer paid / (payer paid + CO contractual write-offs +
 * remaining DENIED balance), over matched remits for current claim versions.
 * Remaining denial balance is max(0, charge - paid - CO - patient responsibility).
 * Patient responsibility is excluded from the payer-expected denominator.
 */
export function computeMetrics(input: readonly MetricClaim[]) {
  const claims = z.array(MetricClaimSchema).parse(input);
  const claimCount = claims.length;
  const submittedCount = claims.filter((claim) => claim.everSubmitted).length;
  const touchlessCount = claims.filter((claim) =>
    (claim.status === "PAID" || claim.status === "PATIENT_BALANCE") && !claim.operatorTaskEverOpened).length;
  const deniedCount = claims.filter((claim) => claim.everSubmitted && claim.status === "DENIED").length;
  let scrubbedEncounterCount = 0;
  const lostUnits: number[] = [];
  const paid: number[] = [];
  const writeOffs: number[] = [];
  const denialBalances: number[] = [];

  for (const claim of claims) {
    if (scrubbedStatuses.has(claim.status)) {
      if (claim.minuteLines === null) throw new RangeError("Scrubbed claim needs its saved minute lines");
      scrubbedEncounterCount++;
      for (const line of claim.minuteLines) {
        const fixture = getCptFixture(line.cptCode);
        if (!fixture || fixture.timed !== line.timed) throw new RangeError("Saved service timing does not match the CPT fixture");
      }
      const allocation = claim.payerType === "COMMERCIAL" && claim.unitRule === "AMA_MIDPOINT"
        ? allocateAmaMidpointUnits(claim.minuteLines)
        : allocateUnits(claim.minuteLines, loadMedicareMinuteLadder());
      const expectedTimed = allocation.totalUnits - claim.minuteLines.filter((line) => !line.timed).length;
      const billedTimed = safeSum(claim.billedLines.map((line) => {
        const fixture = getCptFixture(line.cptCode);
        if (!fixture) throw new RangeError("Unknown billed CPT in metric input");
        return fixture.timed ? line.units : 0;
      }));
      // Saved units, rather than hypothetical per-code rounding, determine the
      // actual shortage under the saved payer policy. A correctly billed claim
      // contributes zero; metrics do not add units to a saved claim.
      lostUnits.push(Math.max(0, expectedTimed - billedTimed));
    }
    if (!claim.remits.length) continue;
    const claimPaid = safeSum(claim.remits.map((remit) => remit.paidCents));
    const claimWriteOff = safeSum(claim.remits.map((remit) => remit.contractualWriteOffCents));
    const patient = safeSum(claim.remits.map((remit) => remit.patientResponsibilityCents));
    paid.push(claimPaid);
    writeOffs.push(claimWriteOff);
    denialBalances.push(claim.status === "DENIED"
      ? Math.max(0, claim.totalChargeCents - claimPaid - claimWriteOff - patient) : 0);
  }

  const unitsLeftOnTable = safeSum(lostUnits);
  const centsLeftOnTable = safeSum([unitsLeftOnTable * TIMED_UNIT_FIXTURE_FEE_CENTS]);
  const paidCents = safeSum(paid);
  const contractualWriteOffCents = safeSum(writeOffs);
  const remainingDenialBalanceCents = safeSum(denialBalances);
  const payerExpectedCents = safeSum([paidCents, contractualWriteOffCents, remainingDenialBalanceCents]);
  return {
    claimCount, submittedCount, scrubbedEncounterCount, touchlessCount, deniedCount,
    touchlessRate: claimCount ? touchlessCount / claimCount : null,
    denialRate: submittedCount ? deniedCount / submittedCount : null,
    unitsLeftOnTable, centsLeftOnTable,
    paidCents, contractualWriteOffCents, remainingDenialBalanceCents, payerExpectedCents,
    netCollectionRate: payerExpectedCents ? paidCents / payerExpectedCents : null,
  };
}
