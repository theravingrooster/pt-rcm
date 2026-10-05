import { z } from "zod";
import { EncounterIngestSchema, type EncounterIngest, type EncounterIngestInput } from "./encounter-ingest.js";
import { getCptFixture } from "./fixtures/index.js";
import { Icd10Schema, IsoDateSchema, NpiSchema, UtcTimestampSchema } from "./models.js";

const SyntheticExternalIdSchema = z.string().regex(
  /^SYN[A-Za-z0-9_-]+$/,
  "Use a synthetic identifier starting with SYN",
);

// Chart times are UTC instants on the date of service. Durations must be an
// exact number of minutes; no caller-supplied minutes or billing units exist
// on this chart input.
const ChartTimestampSchema = UtcTimestampSchema.refine((value) => value.endsWith("Z"),
  "Use a UTC timestamp ending in Z")
  .refine((value) => Date.parse(value) % 60_000 === 0,
    "Timestamp must align to a whole minute");

export const LockedPtNoteSchema = z.object({
  externalNoteId: SyntheticExternalIdSchema,
  patientExternalId: SyntheticExternalIdSchema,
  renderingNpi: NpiSchema,
  dateOfService: IsoDateSchema,
  diagnoses: z.array(Icd10Schema),
  timedEntries: z.array(z.object({
    cptCode: z.string(),
    startTime: ChartTimestampSchema,
    stopTime: ChartTimestampSchema,
    performer: z.enum(["PT", "PTA"]).optional(),
    // A PTA entry without intervals means the PTA furnished the whole entry.
    // Explicit intervals locate the PTA's portion of a mixed PT/PTA entry;
    // minutes are still derived from timestamps after overlap is removed.
    ptaIntervals: z.array(z.object({
      startTime: ChartTimestampSchema,
      stopTime: ChartTimestampSchema,
    }).strict()).min(1).optional(),
  }).strict()),
  untimedEntries: z.array(z.object({ cptCode: z.string() }).strict()).optional(),
}).strict().superRefine((note, context) => {
  for (const [index, entry] of note.timedEntries.entries()) {
    const fixture = getCptFixture(entry.cptCode);
    if (!fixture || !fixture.timed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timedEntries", index, "cptCode"],
        message: "Timed entry requires a timed CPT in the local fixture",
      });
    }
    for (const field of ["startTime", "stopTime"] as const) {
      if (entry[field].slice(0, 10) !== note.dateOfService) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timedEntries", index, field],
          message: "Timestamp must fall on the date of service",
        });
      }
    }
    const durationMs = Date.parse(entry.stopTime) - Date.parse(entry.startTime);
    if (durationMs < 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timedEntries", index, "stopTime"],
        message: "Stop time must not precede start time",
      });
    } else if (durationMs > 480 * 60_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timedEntries", index, "stopTime"],
        message: "Timed entry duration must not exceed 480 minutes",
      });
    } else if (!Number.isInteger(durationMs / 60_000)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timedEntries", index, "stopTime"],
        message: "Timed entry duration must be whole minutes",
      });
    }
    if (entry.ptaIntervals && entry.performer !== "PTA") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timedEntries", index, "ptaIntervals"],
        message: "PTA intervals require performer PTA; PT-performed entries have no PTA minutes",
      });
    }
    const orderedPtaIntervals = (entry.ptaIntervals ?? []).map((interval, intervalIndex) => ({
      ...interval,
      intervalIndex,
      start: Date.parse(interval.startTime),
      stop: Date.parse(interval.stopTime),
    })).sort((left, right) => left.start - right.start || left.stop - right.stop);
    let previousStop = Number.NEGATIVE_INFINITY;
    for (const interval of orderedPtaIntervals) {
      const path = ["timedEntries", index, "ptaIntervals", interval.intervalIndex];
      if (interval.start < Date.parse(entry.startTime) || interval.stop > Date.parse(entry.stopTime)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: "PTA interval must be contained in its timed entry",
        });
      }
      if (interval.stop <= interval.start) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "stopTime"],
          message: "PTA interval must have positive duration",
        });
      }
      if (interval.start < previousStop) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: "PTA intervals must not overlap",
        });
      }
      previousStop = Math.max(previousStop, interval.stop);
    }
  }
  for (const [index, entry] of (note.untimedEntries ?? []).entries()) {
    const fixture = getCptFixture(entry.cptCode);
    if (!fixture || fixture.timed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["untimedEntries", index, "cptCode"],
        message: "Untimed entry requires an untimed CPT or HCPCS code in the local fixture",
      });
    }
  }
});

export type LockedPtNote = z.infer<typeof LockedPtNoteSchema>;
export type LockedPtEncounterContext = Pick<EncounterIngestInput,
  "patient" | "facilityId" | "planOfCare" | "authorizationId">;

export type LockedPtNoteIntervalAnalysis = {
  lines: Array<{
    cptCode: string;
    startTime: string;
    stopTime: string;
    performer: "PT" | "PTA";
    rawMinutes: number;
    billableMinutes: number;
    ptaBillableMinutes: number;
  }>;
  rawTotalMinutes: number;
  billableUnionMinutes: number;
  overlapMinutes: number;
};

/** Credit each one-on-one minute to the earliest interval covering it. */
function analyzeValidatedIntervals(note: LockedPtNote): LockedPtNoteIntervalAnalysis {
  const lines = note.timedEntries.map(({ cptCode, startTime, stopTime, performer }) => ({
    cptCode,
    startTime,
    stopTime,
    performer: performer ?? "PT",
    rawMinutes: (Date.parse(stopTime) - Date.parse(startTime)) / 60_000,
    billableMinutes: 0,
    ptaBillableMinutes: 0,
  }));
  const ordered = lines.map((line, index) => ({
    index,
    start: Date.parse(line.startTime),
    stop: Date.parse(line.stopTime),
  })).sort((left, right) => left.start - right.start || right.stop - left.stop || left.index - right.index);

  let coveredThrough = Number.NEGATIVE_INFINITY;
  let billableUnionMinutes = 0;
  for (const interval of ordered) {
    // A contained interval starts before coveredThrough and credits zero;
    // a gap starts a new piece of the union. Adjacent intervals never overlap.
    const additionalMs = Math.max(0, interval.stop - Math.max(interval.start, coveredThrough));
    const additionalMinutes = additionalMs / 60_000;
    lines[interval.index]!.billableMinutes = additionalMinutes;
    const entry = note.timedEntries[interval.index]!;
    if (entry.performer === "PTA") {
      if (entry.ptaIntervals) {
        const creditedStart = Math.max(interval.start, coveredThrough);
        lines[interval.index]!.ptaBillableMinutes = entry.ptaIntervals.reduce((minutes, portion) => {
          const intersectionMs = Math.max(0, Math.min(interval.stop, Date.parse(portion.stopTime))
            - Math.max(creditedStart, Date.parse(portion.startTime)));
          return minutes + intersectionMs / 60_000;
        }, 0);
      } else {
        lines[interval.index]!.ptaBillableMinutes = additionalMinutes;
      }
    }
    billableUnionMinutes += additionalMinutes;
    coveredThrough = Math.max(coveredThrough, interval.stop);
  }
  const rawTotalMinutes = lines.reduce((sum, line) => sum + line.rawMinutes, 0);
  return { lines, rawTotalMinutes, billableUnionMinutes, overlapMinutes: rawTotalMinutes - billableUnionMinutes };
}

/** Analyze timed chart intervals without billing any minute twice. Untimed entries do not enter the union. */
export function analyzeLockedPtNoteIntervals(noteInput: unknown): LockedPtNoteIntervalAnalysis {
  return analyzeValidatedIntervals(LockedPtNoteSchema.parse(noteInput));
}

/** Convert a locked chart note to the sole existing encounter ingest model. */
export function lockedPtNoteToEncounterInput(noteInput: unknown,
  context: LockedPtEncounterContext): EncounterIngest {
  const note = LockedPtNoteSchema.parse(noteInput);
  if (context.patient.externalId !== note.patientExternalId) {
    throw new RangeError("Chart patient does not match the resolved synthetic patient");
  }
  const analysis = analyzeValidatedIntervals(note);
  return EncounterIngestSchema.parse({
    externalId: `SYN-CHART-${note.externalNoteId}`,
    patient: context.patient,
    renderingProviderNpi: note.renderingNpi,
    facilityId: context.facilityId,
    dateOfService: note.dateOfService,
    diagnoses: note.diagnoses,
    minuteLines: [
      ...analysis.lines.map(({ cptCode, billableMinutes }) => ({ cptCode, minutes: billableMinutes })),
      ...(note.untimedEntries ?? []).map(({ cptCode }) => ({ cptCode, minutes: 0 })),
    ],
    planOfCare: context.planOfCare,
    authorizationId: context.authorizationId,
  });
}
