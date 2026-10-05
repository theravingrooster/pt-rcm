import { inArray } from "drizzle-orm";
import { IdSchema } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { getOperatorEncounter, listOperatorEncounters } from "./operator-read.js";
import * as s from "./schema.js";

const chartPrefix = "SYN-CHART-";

/** Preserve recorded chart times only when they belong to this saved minute line. */
export function chartTimingForLine(notes: string | null, noteId: string, billableMinutes: number) {
  if (!notes) return null;
  try {
    const value: unknown = JSON.parse(notes);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (data.source !== "SYNTHETIC_LOCKED_PT_NOTE" || data.externalNoteId !== noteId
      || typeof data.startTime !== "string" || typeof data.stopTime !== "string"
      || !data.startTime.endsWith("Z") || !data.stopTime.endsWith("Z")) return null;
    const start = Date.parse(data.startTime);
    const stop = Date.parse(data.stopTime);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop < start || (stop - start) % 60_000 !== 0) return null;
    const rawMinutes = (stop - start) / 60_000;
    // Older chart locks recorded only start/stop; their computed minutes were
    // the billable minutes. New locks retain the overlap deduction explicitly.
    if (data.rawMinutes === undefined && data.overlapMinutes === undefined && data.billableMinutes === undefined) {
      if (rawMinutes !== billableMinutes) return null;
    } else if (data.rawMinutes !== rawMinutes || data.billableMinutes !== billableMinutes
      || data.overlapMinutes !== rawMinutes - billableMinutes || rawMinutes < billableMinutes) return null;
    if (data.performer !== undefined && data.performer !== "PT" && data.performer !== "PTA") return null;
    if (data.ptaBillableMinutes !== undefined && (typeof data.ptaBillableMinutes !== "number"
      || !Number.isInteger(data.ptaBillableMinutes)
      || data.ptaBillableMinutes < 0 || data.ptaBillableMinutes > billableMinutes
      || (data.performer !== "PTA" && data.ptaBillableMinutes !== 0))) return null;
    return { startTime: data.startTime, stopTime: data.stopTime, rawMinutes,
      performer: data.performer === "PTA" ? "PTA" as const : "PT" as const,
      ...(data.ptaBillableMinutes !== undefined ? { ptaBillableMinutes: data.ptaBillableMinutes as number } : {}) };
  } catch {
    return null;
  }
}

function chartUntimedForLine(notes: string | null, noteId: string, minutes: number, timed: boolean) {
  if (!notes || timed || minutes !== 0) return false;
  try {
    const data: unknown = JSON.parse(notes);
    return !!data && typeof data === "object" && !Array.isArray(data)
      && (data as Record<string, unknown>).source === "SYNTHETIC_LOCKED_PT_NOTE"
      && (data as Record<string, unknown>).externalNoteId === noteId
      && (data as Record<string, unknown>).untimed === true;
  } catch {
    return false;
  }
}

function chartEntries<T extends { notes: string | null; minutes: number; timed: boolean }>(lines: T[], noteId: string) {
  return lines.map((line) => {
    const untimed = chartUntimedForLine(line.notes, noteId, line.minutes, line.timed);
    const timing = line.timed ? chartTimingForLine(line.notes, noteId, line.minutes) : null;
    return { ...line, untimed, timing, performer: line.timed ? timing?.performer ?? null : null,
      ptaBillableMinutes: line.timed ? timing?.ptaBillableMinutes ?? (timing?.performer === "PTA" ? line.minutes : 0) : 0,
      rawMinutes: line.timed ? timing?.rawMinutes ?? line.minutes : 0,
      billableMinutes: line.timed ? line.minutes : 0 };
  });
}

function chartTotals(entries: ReturnType<typeof chartEntries>) {
  const rawMinutes = entries.reduce((sum, line) => sum + line.rawMinutes, 0);
  const billableUnionMinutes = entries.reduce((sum, line) => sum + line.billableMinutes, 0);
  return { rawMinutes, billableUnionMinutes, overlappingMinutes: rawMinutes - billableUnionMinutes };
}

function noteIdFor(externalId: string) {
  return externalId.startsWith(chartPrefix) ? externalId.slice(chartPrefix.length) : null;
}

/** Locked notes are views of existing encounters and claims, not another billing model. */
export async function listOperatorCharts(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  const rows = (await listOperatorEncounters(db, organizationId))
    .filter(({ encounter }) => noteIdFor(encounter.externalId) !== null);
  if (!rows.length) return [];
  const minuteLines = await db.select().from(s.encounterMinuteLines)
    .where(inArray(s.encounterMinuteLines.encounterId, rows.map(({ encounter }) => encounter.id)))
    .orderBy(s.encounterMinuteLines.cptCode, s.encounterMinuteLines.id);
  return rows.map((row) => {
    const noteId = noteIdFor(row.encounter.externalId)!;
    const entries = chartEntries(minuteLines.filter((line) => line.encounterId === row.encounter.id), noteId);
    return { ...row, noteId, entries, ...chartTotals(entries), status: row.claim?.status ?? "DRAFT" };
  });
}

export async function getOperatorChart(db: Database, organizationId: string, encounterId: string) {
  IdSchema.parse(organizationId); IdSchema.parse(encounterId);
  const row = await getOperatorEncounter(db, organizationId, encounterId);
  const noteId = row ? noteIdFor(row.encounter.externalId) : null;
  if (!row || noteId === null) return null;
  const entries = chartEntries(row.minuteLines, noteId);
  return { ...row, noteId, entries, ...chartTotals(entries), status: row.latestClaim?.status ?? "DRAFT" };
}
