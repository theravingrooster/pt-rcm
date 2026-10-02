import { describe, expect, it } from "vitest";
import { computeMetrics, TIMED_UNIT_FIXTURE_FEE_CENTS, type MetricClaim } from "./metrics.js";

const line = (cptCode: string, minutes: number, timed = true) => ({ cptCode, minutes, timed });
function claim(overrides: Partial<MetricClaim> = {}): MetricClaim {
  return { status: "DRAFT", everSubmitted: false, operatorTaskEverOpened: false,
    totalChargeCents: 0, minuteLines: null, billedLines: [], remits: [], ...overrides };
}

describe("computeMetrics", () => {
  it("returns undefined rates for empty denominators", () => {
    expect(computeMetrics([])).toMatchObject({ claimCount: 0, touchlessRate: null, denialRate: null,
      unitsLeftOnTable: 0, centsLeftOnTable: 0, netCollectionRate: null });
    expect(computeMetrics([claim()])).toMatchObject({ touchlessRate: 0, denialRate: null, netCollectionRate: null });
  });

  it("uses hand-computed claim, denial, unit, and payer-expected denominators", () => {
    const source = [line("97110", 20), line("97530", 20)]; // pooled 40 min = 3 units
    const claims: MetricClaim[] = [
      claim({ status: "PATIENT_BALANCE", everSubmitted: true, totalChargeCents: 10000,
        minuteLines: [line("97110", 15)], billedLines: [{ cptCode: "97110", units: 1 }],
        remits: [{ paidCents: 7000, contractualWriteOffCents: 1000, patientResponsibilityCents: 2000 }] }),
      claim({ status: "PAID", everSubmitted: true, operatorTaskEverOpened: true, totalChargeCents: 5000,
        minuteLines: [line("97140", 15)], billedLines: [{ cptCode: "97140", units: 1 }],
        remits: [{ paidCents: 5000, contractualWriteOffCents: 0, patientResponsibilityCents: 0 }] }),
      claim({ status: "DENIED", everSubmitted: true, totalChargeCents: 9000,
        minuteLines: [line("97112", 30)], billedLines: [{ cptCode: "97112", units: 2 }],
        remits: [{ paidCents: 0, contractualWriteOffCents: 1000, patientResponsibilityCents: 0 }] }),
      claim({ status: "SCRUBBED", totalChargeCents: 9000, minuteLines: source,
        billedLines: [{ cptCode: "97110", units: 1 }, { cptCode: "97530", units: 1 }] }),
      claim(),
    ];
    const input = structuredClone(claims);
    expect(computeMetrics(claims)).toEqual({
      claimCount: 5, submittedCount: 3, scrubbedEncounterCount: 4,
      touchlessCount: 1, deniedCount: 1, touchlessRate: 1 / 5, denialRate: 1 / 3,
      unitsLeftOnTable: 1, centsLeftOnTable: 4500,
      paidCents: 12000, contractualWriteOffCents: 2000, remainingDenialBalanceCents: 8000,
      payerExpectedCents: 22000, netCollectionRate: 12000 / 22000,
    });
    expect(claims).toEqual(input);
    expect(TIMED_UNIT_FIXTURE_FEE_CENTS).toBe(4500);
  });

  it.each([
    { name: "correct pooled billing", billed: [2, 1], status: "SCRUBBED" as const, expected: 0 },
    { name: "one saved unit missing", billed: [1, 1], status: "SCRUBBED" as const, expected: 1 },
    { name: "blocked draft excluded", billed: [1, 1], status: "BLOCKED" as const, expected: 0 },
    { name: "submitted encounter still counted", billed: [1, 1], status: "SUBMITTED" as const, expected: 1 },
  ])("counts $name against stored units", ({ billed, status, expected }) => {
    const metric = computeMetrics([claim({ status,
      minuteLines: [line("97110", 20), line("97530", 20), line("G0283", 0, false)],
      billedLines: [{ cptCode: "97110", units: billed[0]! }, { cptCode: "97530", units: billed[1]! }, { cptCode: "G0283", units: 1 }],
    })]);
    expect(metric.unitsLeftOnTable).toBe(expected);
    expect(metric.centsLeftOnTable).toBe(expected * 4500);
  });

  it("excludes patient responsibility and unremitted claims from payer collection", () => {
    const value = computeMetrics([
      claim({ status: "PATIENT_BALANCE", everSubmitted: true, totalChargeCents: 10000,
        minuteLines: [], remits: [{ paidCents: 6000, contractualWriteOffCents: 0, patientResponsibilityCents: 4000 }] }),
      claim({ status: "DENIED", everSubmitted: true, totalChargeCents: 9000,
        minuteLines: [], remits: [] }),
    ]);
    expect(value).toMatchObject({ paidCents: 6000, remainingDenialBalanceCents: 0,
      payerExpectedCents: 6000, netCollectionRate: 1 });
  });

  it.each([
    claim({ status: "SCRUBBED", minuteLines: null }),
    claim({ status: "SCRUBBED", minuteLines: [line("97110", 20, false)] }),
    claim({ remits: [{ paidCents: -1, contractualWriteOffCents: 0, patientResponsibilityCents: 0 }] }),
  ])("rejects invalid metric input %#", (invalid) => {
    expect(() => computeMetrics([invalid])).toThrow();
  });
});
