import { createHash } from "node:crypto";
import type { Coverage, Diagnosis, Encounter, EncounterMinuteLine } from "@pt-rcm/domain";

/** Callers load minute lines by CPT+ID and diagnoses by pointer. Status is not clinical input. */
export function encounterSourceFingerprint(encounter: Encounter, coverage: Coverage,
  minuteLines: EncounterMinuteLine[], diagnoses: Diagnosis[]): string {
  return createHash("sha256").update(JSON.stringify({
    encounter: { ...encounter, status: undefined }, coverage, minuteLines, diagnoses,
  })).digest("hex");
}
