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
  "Use a UTC timestamp ending in Z");

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
  }).strict()),
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
  }
});

export type LockedPtNote = z.infer<typeof LockedPtNoteSchema>;
export type LockedPtEncounterContext = Pick<EncounterIngestInput,
  "patient" | "facilityId" | "planOfCare" | "authorizationId">;

/** Convert a locked chart note to the sole existing encounter ingest model. */
export function lockedPtNoteToEncounterInput(noteInput: unknown,
  context: LockedPtEncounterContext): EncounterIngest {
  const note = LockedPtNoteSchema.parse(noteInput);
  if (context.patient.externalId !== note.patientExternalId) {
    throw new RangeError("Chart patient does not match the resolved synthetic patient");
  }
  return EncounterIngestSchema.parse({
    externalId: `SYN-CHART-${note.externalNoteId}`,
    patient: context.patient,
    renderingProviderNpi: note.renderingNpi,
    facilityId: context.facilityId,
    dateOfService: note.dateOfService,
    diagnoses: note.diagnoses,
    minuteLines: note.timedEntries.map(({ cptCode, startTime, stopTime }) => ({
      cptCode,
      minutes: (Date.parse(stopTime) - Date.parse(startTime)) / 60_000,
    })),
    planOfCare: context.planOfCare,
    authorizationId: context.authorizationId,
  });
}
