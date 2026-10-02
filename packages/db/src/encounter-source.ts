import { createHash } from "node:crypto";
import type { Coverage, Diagnosis, Encounter, EncounterMinuteLine } from "@pt-rcm/domain";

/** Callers load minute lines by CPT+ID and diagnoses by pointer. Status is not clinical input. */
export function encounterSourceFingerprint(encounter: Encounter, coverage: Coverage,
  minuteLines: EncounterMinuteLine[], diagnoses: Diagnosis[]): string {
  // Eligibility is a time-sensitive cache, not a change to the recorded
  // encounter. Rechecking it must not create a new claim version.
  const { eligible: _eligible, checkedAt: _checkedAt,
    deductibleRemainingCents: _deductible, planActive: _planActive, ...sourceCoverage } = coverage;
  return createHash("sha256").update(JSON.stringify({
    encounter: { ...encounter, status: undefined }, coverage: sourceCoverage, minuteLines, diagnoses,
  })).digest("hex");
}

/** Compare the check that was used for scrub with the current cached check. */
export function sameEligibilityCheck(saved: Partial<Coverage>, current: Coverage): boolean {
  return (saved.eligible ?? null) === current.eligible
    && (saved.checkedAt ?? null) === current.checkedAt
    && (saved.deductibleRemainingCents ?? null) === current.deductibleRemainingCents
    && (saved.planActive ?? null) === current.planActive;
}
