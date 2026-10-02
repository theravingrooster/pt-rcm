// Fixture reference data only. Bounds are inclusive and use whole timed minutes.
const medicareMinuteLadder = Object.freeze(([
  { minMinutes: 0, maxMinutes: 7, units: 0 },
  { minMinutes: 8, maxMinutes: 22, units: 1 },
  { minMinutes: 23, maxMinutes: 37, units: 2 },
  { minMinutes: 38, maxMinutes: 52, units: 3 },
  { minMinutes: 53, maxMinutes: 67, units: 4 },
  { minMinutes: 68, maxMinutes: 82, units: 5 },
] as const).map((row) => Object.freeze(row)));

export type MedicareMinuteBracket = (typeof medicareMinuteLadder)[number];

// 2026 Medicare PT/SLP KX threshold; verify against the current CMS therapy threshold before any non-fixture use.
export const MEDICARE_PT_SLP_KX_THRESHOLD_2026_CENTS = 248000;

export function loadMedicareMinuteLadder(): readonly MedicareMinuteBracket[] {
  return medicareMinuteLadder;
}

// Converts a supplied total only. Does not allocate units, select services, or create claim lines.
export function minutesToUnits(totalTimedMinutes: number): number {
  if (!Number.isSafeInteger(totalTimedMinutes) || totalTimedMinutes < 0) {
    throw new RangeError("totalTimedMinutes must be a nonnegative safe integer");
  }

  const bracket = medicareMinuteLadder.find(
    (row) => totalTimedMinutes >= row.minMinutes && totalTimedMinutes <= row.maxMinutes,
  );
  if (bracket) return bracket.units;

  const last = medicareMinuteLadder[medicareMinuteLadder.length - 1]!;
  const minutesPerAdditionalUnit = last.maxMinutes - last.minMinutes + 1;
  return last.units + Math.ceil((totalTimedMinutes - last.maxMinutes) / minutesPerAdditionalUnit);
}
