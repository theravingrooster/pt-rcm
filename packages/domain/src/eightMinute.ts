import { loadMedicareMinuteLadder, minutesToUnits, type MedicareMinuteBracket } from "./fixtures/medicare.js";

export type UnitAllocationInputLine = Readonly<{
  cptCode: string;
  minutes: number;
  timed: boolean;
}>;

export type AllocatedMinuteLine = {
  cptCode: string;
  minutes: number;
  units: number;
  remainderMinutes: number;
};

export type UnitAllocationFlag = {
  lineIndex: number;
  cptCode: string;
  outcome: "FLAG";
  reason: "ZERO_MINUTES";
};

export type UnitAllocation = {
  lines: AllocatedMinuteLine[];
  totalTimedMinutes: number;
  /** Sum of all output units, including one per present untimed line. */
  totalUnits: number;
  /** Sum of timed-line remainders, not additional billable minutes or units. */
  unusedMinutes: number;
  flags: UnitAllocationFlag[];
};

/**
 * Allocate one day's supplied lines; the caller supplies fixture timing flags.
 *
 * Assignment rule: take the daily timed-unit budget from the ladder on the SUM.
 * Repeatedly assign a unit to the line with the most unassigned minutes, breaking
 * ties by CPT ascending (then original index for duplicate codes), and consume
 * up to 15 of that line's minutes. Batch all complete 15-minute blocks first;
 * this is equivalent to that greedy assignment and avoids a loop per unit.
 * Award any remaining daily units by longest remainder, with the same tie break.
 * Never award a unit to a zero remainder or exceed the daily timed-unit budget.
 *
 * Preserve input order and original minutes, including zero-minute lines.
 * remainderMinutes is max(0, minutes - 15 * units) for timed lines and zero for
 * untimed lines. unusedMinutes sums these remainders; it can be >= 8 even when
 * the daily budget is exhausted (e.g. two 8-minute lines allow only one unit).
 * Untimed units are independent of the ladder and included in totalUnits.
 */
export function allocateUnits(
  lines: readonly UnitAllocationInputLine[],
  ladder: readonly MedicareMinuteBracket[],
): UnitAllocation {
  let totalTimedMinutes = 0;
  let fullTimedUnits = 0;
  const flags: UnitAllocationFlag[] = [];
  const timedIndexes: number[] = [];
  const allocated = lines.map((line, lineIndex): AllocatedMinuteLine => {
    if (!Number.isSafeInteger(line.minutes) || line.minutes < 0) {
      throw new RangeError("minutes must be a nonnegative safe integer");
    }
    if (!line.timed) return { cptCode: line.cptCode, minutes: line.minutes, units: 1, remainderMinutes: 0 };
    totalTimedMinutes += line.minutes;
    if (!Number.isSafeInteger(totalTimedMinutes)) throw new RangeError("totalTimedMinutes exceeds the safe integer range");
    const units = Math.floor(line.minutes / 15);
    fullTimedUnits += units;
    timedIndexes.push(lineIndex);
    if (line.minutes === 0) flags.push({ lineIndex, cptCode: line.cptCode, outcome: "FLAG", reason: "ZERO_MINUTES" });
    return { cptCode: line.cptCode, minutes: line.minutes, units, remainderMinutes: line.minutes % 15 };
  });

  const timedUnitBudget = minutesToUnits(totalTimedMinutes, ladder);
  let unitsToAssign = timedUnitBudget - fullTimedUnits;
  timedIndexes.sort((leftIndex, rightIndex) => {
    const left = allocated[leftIndex]!;
    const right = allocated[rightIndex]!;
    return right.remainderMinutes - left.remainderMinutes
      || (left.cptCode < right.cptCode ? -1 : left.cptCode > right.cptCode ? 1 : 0)
      || leftIndex - rightIndex;
  });
  for (const index of timedIndexes) {
    if (unitsToAssign === 0) break;
    const line = allocated[index]!;
    if (line.remainderMinutes === 0) continue;
    line.units += 1;
    line.remainderMinutes = 0;
    unitsToAssign -= 1;
  }

  return {
    lines: allocated,
    totalTimedMinutes,
    totalUnits: allocated.reduce((sum, line) => sum + line.units, 0),
    unusedMinutes: allocated.reduce((sum, line) => sum + line.remainderMinutes, 0),
    flags,
  };
}

/** Compare daily pooling with rounding each timed CPT separately; untimed units cancel out. */
export function unitsLeftOnTable(lines: readonly UnitAllocationInputLine[]): number {
  const allocation = allocateUnits(lines, loadMedicareMinuteLadder());
  const minutesByCode = new Map<string, number>();
  let perCodeRoundedUnits = 0;
  for (const line of lines) {
    if (line.timed) minutesByCode.set(line.cptCode, (minutesByCode.get(line.cptCode) ?? 0) + line.minutes);
    else perCodeRoundedUnits += 1;
  }
  for (const minutes of minutesByCode.values()) perCodeRoundedUnits += minutesToUnits(minutes);
  return Math.max(0, allocation.totalUnits - perCodeRoundedUnits);
}
