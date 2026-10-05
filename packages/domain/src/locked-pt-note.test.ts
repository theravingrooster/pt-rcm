import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocateUnits } from "./eightMinute.js";
import { loadMedicareMinuteLadder } from "./fixtures/index.js";
import { type EncounterIngestInput } from "./encounter-ingest.js";
import { analyzeLockedPtNoteIntervals, LockedPtNoteSchema, lockedPtNoteToEncounterInput } from "./locked-pt-note.js";

const shoulder = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;
const overlapping = JSON.parse(readFileSync(new URL("../../../fixtures/charts/overlapping-30min.json", import.meta.url), "utf8")) as typeof note;
const pta = JSON.parse(readFileSync(new URL("../../../fixtures/charts/pta-20min.json", import.meta.url), "utf8")) as typeof note;
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
    expect(analyzeLockedPtNoteIntervals(note)).toMatchObject({
      rawTotalMinutes: 40,
      billableUnionMinutes: 40,
      overlapMinutes: 0,
      lines: [{ rawMinutes: 20, billableMinutes: 20, performer: "PT", ptaBillableMinutes: 0 },
        { rawMinutes: 20, billableMinutes: 20, performer: "PT", ptaBillableMinutes: 0 }],
    });
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

  it("derives full and exactly 10 percent PTA portions from the fixture timestamps", () => {
    expect(analyzeLockedPtNoteIntervals(pta)).toMatchObject({ rawTotalMinutes: 40,
      billableUnionMinutes: 40, lines: [
        { cptCode: "97110", performer: "PTA", billableMinutes: 20, ptaBillableMinutes: 20 },
        { cptCode: "97140", performer: "PTA", billableMinutes: 20, ptaBillableMinutes: 2 },
      ] });
    const encounter = lockedPtNoteToEncounterInput(pta, context);
    expect(encounter.minuteLines).toEqual([{ cptCode: "97110", minutes: 20 }, { cptCode: "97140", minutes: 20 }]);
    expect(allocateUnits(encounter.minuteLines.map((line) => ({ ...line, timed: true })),
      loadMedicareMinuteLadder()).totalUnits).toBe(3);
  });

  it("credits only PTA portions inside the billable union after overlapping minutes are removed", () => {
    const mixedOverlap = { ...note, timedEntries: [
      { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z", performer: "PT" },
      { cptCode: "97140", startTime: "2026-10-01T09:10:00Z", stopTime: "2026-10-01T09:30:00Z", performer: "PTA",
        ptaIntervals: [
          { startTime: "2026-10-01T09:15:00Z", stopTime: "2026-10-01T09:18:00Z" },
          { startTime: "2026-10-01T09:28:00Z", stopTime: "2026-10-01T09:29:00Z" },
        ] },
    ] };
    expect(analyzeLockedPtNoteIntervals(mixedOverlap)).toMatchObject({
      rawTotalMinutes: 40,
      billableUnionMinutes: 30,
      lines: [{ billableMinutes: 20, ptaBillableMinutes: 0 },
        { billableMinutes: 10, ptaBillableMinutes: 1 }],
    });
    expect(lockedPtNoteToEncounterInput(mixedOverlap, context).minuteLines).toEqual([
      { cptCode: "97110", minutes: 20 }, { cptCode: "97140", minutes: 10 },
    ]);
  });

  it("derives a PTA portion greater than ten percent without changing a PT entry", () => {
    const partial = { ...note, timedEntries: [
      { ...note.timedEntries[0], performer: "PTA", ptaIntervals: [
        { startTime: "2026-10-01T09:17:00Z", stopTime: "2026-10-01T09:20:00Z" },
      ] },
      note.timedEntries[1],
    ] };
    expect(analyzeLockedPtNoteIntervals(partial).lines).toMatchObject([
      { performer: "PTA", billableMinutes: 20, ptaBillableMinutes: 3 },
      { performer: "PT", billableMinutes: 20, ptaBillableMinutes: 0 },
    ]);
  });

  it("rejects PTA portions on PT lines or outside and overlapping within their entry", () => {
    const first = note.timedEntries[0]!;
    const portion = { startTime: "2026-10-01T09:18:00Z", stopTime: "2026-10-01T09:20:00Z" };
    const parsed = (entry: unknown) => LockedPtNoteSchema.safeParse({ ...note, timedEntries: [entry] });
    expect(parsed({ ...first, performer: "PT", ptaIntervals: [portion] }).success).toBe(false);
    expect(parsed({ ...first, ptaIntervals: [portion] }).success).toBe(false);
    expect(parsed({ ...first, performer: "PTA", ptaIntervals: [
      { startTime: "2026-10-01T09:18:00Z", stopTime: "2026-10-01T09:21:00Z" },
    ] }).success).toBe(false);
    expect(parsed({ ...first, performer: "PTA", ptaIntervals: [
      portion, { startTime: "2026-10-01T09:19:00Z", stopTime: "2026-10-01T09:20:00Z" },
    ] }).success).toBe(false);
    expect(parsed({ ...first, performer: "PTA", ptaIntervals: [
      { startTime: "2026-10-01T09:18:00Z", stopTime: "2026-10-01T09:18:00Z" },
    ] }).success).toBe(false);
  });

  it("credits only the 30-minute union of overlapping intervals to encounter lines and the allocator", () => {
    const analysis = analyzeLockedPtNoteIntervals(overlapping);
    expect(analysis).toMatchObject({
      rawTotalMinutes: 40,
      billableUnionMinutes: 30,
      overlapMinutes: 10,
      lines: [
        { cptCode: "97110", rawMinutes: 20, billableMinutes: 20 },
        { cptCode: "97140", rawMinutes: 20, billableMinutes: 10 },
      ],
    });
    const encounter = lockedPtNoteToEncounterInput(overlapping, context);
    expect(encounter.minuteLines).toEqual([
      { cptCode: "97110", minutes: 20 },
      { cptCode: "97140", minutes: 10 },
    ]);
    const allocation = allocateUnits(encounter.minuteLines.map((line) => ({ ...line, timed: true })), loadMedicareMinuteLadder());
    expect(allocation.totalTimedMinutes).toBe(30);
    expect(allocation.totalUnits).toBe(2);
  });

  it("credits an entirely contained interval zero even when it appears first", () => {
    const reversed = { ...overlapping, timedEntries: [
      { cptCode: "97140", startTime: "2026-10-01T09:10:00Z", stopTime: "2026-10-01T09:15:00Z" },
      { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" },
    ] };
    expect(analyzeLockedPtNoteIntervals(reversed)).toMatchObject({
      rawTotalMinutes: 25,
      billableUnionMinutes: 20,
      overlapMinutes: 5,
      lines: [{ billableMinutes: 0 }, { billableMinutes: 20 }],
    });
    expect(lockedPtNoteToEncounterInput(reversed, context).minuteLines.map((line) => line.minutes)).toEqual([0, 20]);
  });

  it("credits the longer interval first when two entries share a start", () => {
    const sameStart = { ...overlapping, timedEntries: [
      { cptCode: "97140", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:10:00Z" },
      { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" },
    ] };
    expect(analyzeLockedPtNoteIntervals(sameStart)).toMatchObject({
      rawTotalMinutes: 30,
      billableUnionMinutes: 20,
      lines: [{ billableMinutes: 0 }, { billableMinutes: 20 }],
    });
  });

  it("counts the union across multiple overlaps and gaps", () => {
    const intervals = { ...overlapping, timedEntries: [
      { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:10:00Z" },
      { cptCode: "97140", startTime: "2026-10-01T09:05:00Z", stopTime: "2026-10-01T09:25:00Z" },
      { cptCode: "97530", startTime: "2026-10-01T09:15:00Z", stopTime: "2026-10-01T09:30:00Z" },
      { cptCode: "97112", startTime: "2026-10-01T09:40:00Z", stopTime: "2026-10-01T09:48:00Z" },
    ] };
    expect(analyzeLockedPtNoteIntervals(intervals)).toMatchObject({
      rawTotalMinutes: 53,
      billableUnionMinutes: 38,
      overlapMinutes: 15,
      lines: [{ billableMinutes: 10 }, { billableMinutes: 15 }, { billableMinutes: 5 }, { billableMinutes: 8 }],
    });
  });

  it("excludes an untimed evaluation from the union and keeps its independent unit", () => {
    const withEvaluation = { ...overlapping, untimedEntries: [{ cptCode: "97161" }] };
    expect(analyzeLockedPtNoteIntervals(withEvaluation)).toMatchObject({
      rawTotalMinutes: 40,
      billableUnionMinutes: 30,
      overlapMinutes: 10,
      lines: [{ billableMinutes: 20 }, { billableMinutes: 10 }],
    });
    const encounter = lockedPtNoteToEncounterInput(withEvaluation, context);
    expect(encounter.minuteLines).toEqual([
      { cptCode: "97110", minutes: 20 },
      { cptCode: "97140", minutes: 10 },
      { cptCode: "97161", minutes: 0 },
    ]);
    const allocation = allocateUnits(encounter.minuteLines.map((line) => ({
      ...line, timed: line.cptCode !== "97161",
    })), loadMedicareMinuteLadder());
    expect(allocation.totalTimedMinutes).toBe(30);
    expect(allocation.totalUnits).toBe(3);
  });

  it("rejects timed CPTs in untimed entries and caller-supplied minutes", () => {
    expect(LockedPtNoteSchema.safeParse({ ...note, untimedEntries: [{ cptCode: "97110" }] }).success).toBe(false);
    expect(LockedPtNoteSchema.safeParse({ ...note, untimedEntries: [{ cptCode: "97161", minutes: 20 }] }).success).toBe(false);
    expect(LockedPtNoteSchema.safeParse({ ...note, untimedEntries: [{ cptCode: "97161", performer: "PTA" }] }).success).toBe(false);
    expect(LockedPtNoteSchema.safeParse({ ...note, timedEntries: [{ ...note.timedEntries[0], performer: "OTHER" }] }).success).toBe(false);
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
    expect(LockedPtNoteSchema.safeParse({ ...note, timedEntries: [{ ...note.timedEntries[0], ptaMinutes: 2 }] }).success).toBe(false);
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
