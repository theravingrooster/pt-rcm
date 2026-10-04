import { inArray } from "drizzle-orm";
import { IdSchema } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { getOperatorEncounter, listOperatorEncounters } from "./operator-read.js";
import * as s from "./schema.js";

const chartPrefix = "SYN-CHART-";

/** Preserve recorded chart times only when they belong to this saved minute line. */
export function chartTimingForLine(notes: string | null, noteId: string, minutes: number) {
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
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop - start !== minutes * 60_000) return null;
    return { startTime: data.startTime, stopTime: data.stopTime };
  } catch {
    return null;
  }
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
    const entries = minuteLines.filter((line) => line.encounterId === row.encounter.id).map((line) => ({
      ...line, timing: chartTimingForLine(line.notes, noteId, line.minutes),
    }));
    return { ...row, noteId, entries, status: row.claim?.status ?? "DRAFT" };
  });
}

export async function getOperatorChart(db: Database, organizationId: string, encounterId: string) {
  IdSchema.parse(organizationId); IdSchema.parse(encounterId);
  const row = await getOperatorEncounter(db, organizationId, encounterId);
  const noteId = row ? noteIdFor(row.encounter.externalId) : null;
  if (!row || noteId === null) return null;
  return { ...row, noteId, entries: row.minuteLines.map((line) => ({
    ...line, timing: chartTimingForLine(line.notes, noteId, line.minutes),
  })), status: row.latestClaim?.status ?? "DRAFT" };
}
