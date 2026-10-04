import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocateUnits } from "./eightMinute.js";
import { loadMedicareMinuteLadder } from "./fixtures/index.js";
import { type EncounterIngestInput } from "./encounter-ingest.js";
import { LockedPtNoteSchema, lockedPtNoteToEncounterInput } from "./locked-pt-note.js";

const shoulder = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;
const context = { patient: shoulder.patient, facilityId: shoulder.facilityId, planOfCare: shoulder.planOfCare };

// CPT is AMA-licensed. These two procedure codes are from the local fixture only.
const note = {
  externalNoteId: "SYN-SHOULDER-NOTE-1",
  patientExternalId: shoulder.patient.externalId,
  renderingNpi: shoulder.renderingProviderNpi,
  dateOfService: shoulder.dateOfService,
  diagnoses: ["M25.511"],
  timedEntries: [
    { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" },
    { cptCode: "97530", startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z" },
  ],
};

describe("locked synthetic PT note", () => {
  it("derives 20 + 20 minutes solely from timestamps and leaves billing allocation to the existing model", () => {
    const result = lockedPtNoteToEncounterInput(note, context);
    expect(result).toMatchObject({
      externalId: "SYN-CHART-SYN-SHOULDER-NOTE-1",
      patient: { externalId: note.patientExternalId },
      renderingProviderNpi: note.renderingNpi,
      diagnoses: ["M25.511"],
      minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }],
    });
    expect("units" in result.minuteLines[0]!).toBe(false);
    const allocation = allocateUnits(result.minuteLines.map((line) => ({ ...line, timed: true })), loadMedicareMinuteLadder());
    expect(allocation.totalUnits).toBe(3);
  });

  it.each([
    ["09:00:00", "09:00:00", 0],
    ["09:00:00", "09:08:00", 8],
    ["09:00:00", "17:00:00", 480],
  ])("computes %s to %s as %i whole minutes", (start, stop, expected) => {
    const result = lockedPtNoteToEncounterInput({ ...note, timedEntries: [{
      cptCode: "97110", startTime: `2026-10-01T${start}Z`, stopTime: `2026-10-01T${stop}Z`,
    }] }, context);
    expect(result.minuteLines).toEqual([{ cptCode: "97110", minutes: expected }]);
  });

  it.each([
    [{ startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:00:00Z" }, "stopTime"],
    [{ startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T17:01:00Z" }, "stopTime"],
    [{ startTime: "2026-10-01T09:00:30Z", stopTime: "2026-10-01T09:20:00Z" }, "stopTime"],
    [{ startTime: "2026-09-30T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" }, "startTime"],
    [{ startTime: "2026-10-01T09:00:00+00:00", stopTime: "2026-10-01T09:20:00Z" }, "startTime"],
  ])("rejects invalid interval %# at %s", (times, issueField) => {
    const parsed = LockedPtNoteSchema.safeParse({ ...note, timedEntries: [{ cptCode: "97110", ...times }] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.includes(issueField))).toBe(true);
  });

  it.each(["99999", "97161", "G0283"])("rejects %s outside the timed fixture", (cptCode) => {
    expect(LockedPtNoteSchema.safeParse({ ...note, timedEntries: [{ ...note.timedEntries[0], cptCode }] }).success).toBe(false);
  });

  it("rejects caller-provided minutes and unrelated demographic or billing data", () => {
    expect(LockedPtNoteSchema.safeParse({ ...note, minutes: 40 }).success).toBe(false);
    expect(LockedPtNoteSchema.safeParse({ ...note, patientName: "Actual Name" }).success).toBe(false);
    expect(LockedPtNoteSchema.safeParse({ ...note, memberId: "SYN-EXTRA" }).success).toBe(false);
    expect(LockedPtNoteSchema.safeParse({ ...note, timedEntries: [{ ...note.timedEntries[0], minutes: 19 }] }).success).toBe(false);
    expect(LockedPtNoteSchema.safeParse({ ...note, timedEntries: [{ ...note.timedEntries[0], units: 4 }] }).success).toBe(false);
  });

  it.each([
    { patientExternalId: "REAL-123" },
    { externalNoteId: "real-note" },
    { renderingNpi: "1234567890" },
  ])("requires synthetic note, patient and provider identifiers %#", (invalid) => {
    expect(LockedPtNoteSchema.safeParse({ ...note, ...invalid }).success).toBe(false);
  });

  it("does not pair a note with another patient during ingest conversion", () => {
    expect(() => lockedPtNoteToEncounterInput(note, {
      ...context, patient: { ...context.patient, externalId: "SYN-OTHER" },
    })).toThrow("Chart patient does not match");
  });
});
