import type { UnitAllocation, UnitAllocationInputLine } from "./eightMinute.js";

/**
 * Round timed services at the 8-minute midpoint of each 15-minute unit,
 * independently for each CPT code. Some commercial payers use this method;
 * Medicare's daily 8-minute allocator remains allocateUnits.
 *
 * Repeated lines with the same code share that code's minute budget. Give each
 * line its complete 15-minute units first, then distribute the remaining
 * units to lines with the largest unassigned minutes (original index breaks
 * ties). This preserves the input order and never changes recorded minutes.
 */
export function allocateAmaMidpointUnits(lines: readonly UnitAllocationInputLine[]): UnitAllocation {
  let totalTimedMinutes = 0;
  const flags: UnitAllocation["flags"] = [];
  const indexesByCode = new Map<string, number[]>();
  const minutesByCode = new Map<string, number>();

  const allocated: UnitAllocation["lines"] = lines.map((line, lineIndex) => {
    if (!Number.isSafeInteger(line.minutes) || line.minutes < 0) {
      throw new RangeError("minutes must be a nonnegative safe integer");
    }
    if (!line.timed) return { cptCode: line.cptCode, minutes: line.minutes, units: 1, remainderMinutes: 0 };

    totalTimedMinutes += line.minutes;
    if (!Number.isSafeInteger(totalTimedMinutes)) throw new RangeError("totalTimedMinutes exceeds the safe integer range");
    minutesByCode.set(line.cptCode, (minutesByCode.get(line.cptCode) ?? 0) + line.minutes);
    const indexes = indexesByCode.get(line.cptCode) ?? [];
    indexes.push(lineIndex);
    indexesByCode.set(line.cptCode, indexes);
    if (line.minutes === 0) flags.push({ lineIndex, cptCode: line.cptCode, outcome: "FLAG", reason: "ZERO_MINUTES" });

    const units = Math.floor(line.minutes / 15);
    return { cptCode: line.cptCode, minutes: line.minutes, units, remainderMinutes: line.minutes % 15 };
  });

  for (const [code, indexes] of indexesByCode) {
    const minutes = minutesByCode.get(code)!;
    const budget = Math.floor(minutes / 15) + (minutes % 15 >= 8 ? 1 : 0);
    let unitsToAssign = budget - indexes.reduce((sum, index) => sum + allocated[index]!.units, 0);
    indexes.sort((left, right) => allocated[right]!.remainderMinutes - allocated[left]!.remainderMinutes || left - right);
    for (const index of indexes) {
      if (unitsToAssign === 0) break;
      const line = allocated[index]!;
      if (line.remainderMinutes === 0) continue;
      line.units += 1;
      line.remainderMinutes = 0;
      unitsToAssign -= 1;
    }
  }

  const totalUnits = allocated.reduce((sum, line) => sum + line.units, 0);
  if (!Number.isSafeInteger(totalUnits)) throw new RangeError("totalUnits exceeds the safe integer range");
  return {
    lines: allocated,
    totalTimedMinutes,
    totalUnits,
    unusedMinutes: allocated.reduce((sum, line) => sum + line.remainderMinutes, 0),
    flags,
  };
}
