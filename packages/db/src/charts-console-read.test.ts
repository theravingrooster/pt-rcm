import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EncounterIngestInput, LockedPtNote } from "@pt-rcm/domain";
import { createDatabase } from "./index.js";
import { lockPtChartNote } from "./chart-lock.js";
import { chartTimingForLine, getOperatorChart, listOperatorCharts } from "./charts-console-read.js";
import { upsertEncounter } from "./encounter-ingest.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization } from "./seed-data.js";
import * as s from "./schema.js";

const noteId = "SYN-SHOULDER-LOCK";
const timing = { source: "SYNTHETIC_LOCKED_PT_NOTE", externalNoteId: noteId,
  startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" };

describe("locked chart timing read model", () => {
  it("shows only validated recorded times that produce the saved computed minutes", () => {
    expect(chartTimingForLine(JSON.stringify(timing), noteId, 20)).toEqual({
      startTime: timing.startTime, stopTime: timing.stopTime, rawMinutes: 20, performer: "PT",
    });
    expect(chartTimingForLine(JSON.stringify(timing), noteId, 19)).toBeNull();
    expect(chartTimingForLine(JSON.stringify(timing), "SYN-OTHER", 20)).toBeNull();
  });

  it("reads a saved PTA performer and rejects an unknown performer", () => {
    expect(chartTimingForLine(JSON.stringify({ ...timing, performer: "PTA" }), noteId, 20))
      .toMatchObject({ performer: "PTA", rawMinutes: 20 });
    expect(chartTimingForLine(JSON.stringify({ ...timing, performer: "ASSISTANT" }), noteId, 20)).toBeNull();
    expect(chartTimingForLine(JSON.stringify({ ...timing, performer: "PTA", rawMinutes: 20,
      billableMinutes: 20, overlapMinutes: 0, ptaBillableMinutes: 2 }), noteId, 20))
      .toMatchObject({ performer: "PTA", ptaBillableMinutes: 2 });
    expect(chartTimingForLine(JSON.stringify({ ...timing, performer: "PT", rawMinutes: 20,
      billableMinutes: 20, overlapMinutes: 0, ptaBillableMinutes: 2 }), noteId, 20)).toBeNull();
  });

  it.each([null, "not json", JSON.stringify({ ...timing, stopTime: "2026-10-01T08:40:00Z" }),
    JSON.stringify({ ...timing, source: "UNKNOWN" })])("does not invent times for missing or malformed metadata: %s", (notes) => {
    expect(chartTimingForLine(notes, noteId, 20)).toBeNull();
  });

  it("keeps the full recorded interval while validating overlap credit", () => {
    const notes = JSON.stringify({ ...timing, rawMinutes: 20, billableMinutes: 10, overlapMinutes: 10 });
    expect(chartTimingForLine(notes, noteId, 10)).toEqual({
      startTime: timing.startTime, stopTime: timing.stopTime, rawMinutes: 20, performer: "PT",
    });
    expect(chartTimingForLine(notes, noteId, 20)).toBeNull();
    expect(chartTimingForLine(JSON.stringify({ ...timing, rawMinutes: 20, billableMinutes: 10,
      overlapMinutes: 9 }), noteId, 10)).toBeNull();
  });
});

const url = process.env.TEST_DATABASE_URL;
const patientExternalId = `SYN-CHART-READ-PATIENT-${randomUUID()}`;
const lockedNoteId = `SYN-CHART-READ-NOTE-${randomUUID()}`;
const overlappingNoteId = `SYN-CHART-OVERLAP-NOTE-${randomUUID()}`;
const ptaNoteId = `SYN-CHART-PTA-NOTE-${randomUUID()}`;
const original = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;
const overlappingFixture = JSON.parse(readFileSync(new URL("../../../fixtures/charts/overlapping-30min.json", import.meta.url), "utf8")) as LockedPtNote;
const ptaFixture = JSON.parse(readFileSync(new URL("../../../fixtures/charts/pta-20min.json", import.meta.url), "utf8")) as LockedPtNote;

describe.skipIf(!url)("Charts read model with a locked shoulder note", () => {
  let connection: ReturnType<typeof createDatabase>;
  let patientId: string;
  let encounterId: string;
  let overlappingEncounterId: string;
  let ptaEncounterId: string;
  let baseEncounterId: string;

  beforeAll(async () => {
    connection = createDatabase(url!);
    await seedSyntheticData(connection.db);
    const base = await upsertEncounter(connection.db, seedOrganization.id, {
      ...original, externalId: `SYN-BASE-CHART-READ-${randomUUID()}`,
      patient: { ...original.patient, externalId: patientExternalId },
    });
    patientId = base.patientId;
    baseEncounterId = base.encounterId;
    const locked = await lockPtChartNote(connection.db, seedOrganization.id, {
      externalNoteId: lockedNoteId, patientExternalId, renderingNpi: "0000000003", dateOfService: "2026-10-01",
      diagnoses: ["M25.511"], timedEntries: [
        { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" },
        { cptCode: "97530", startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z" },
      ],
    });
    encounterId = locked.encounterId;
    const overlapping = await lockPtChartNote(connection.db, seedOrganization.id, {
      ...overlappingFixture, externalNoteId: overlappingNoteId, patientExternalId,
    });
    overlappingEncounterId = overlapping.encounterId;
    const pta = await lockPtChartNote(connection.db, seedOrganization.id, {
      ...ptaFixture, externalNoteId: ptaNoteId, patientExternalId,
    });
    ptaEncounterId = pta.encounterId;
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      if (patientId) await connection.db.transaction(async (tx) => {
        const encounterIds = [baseEncounterId, encounterId, overlappingEncounterId, ptaEncounterId].filter(Boolean);
        const claims = await tx.select({ id: s.claims.id }).from(s.claims).where(inArray(s.claims.encounterId, encounterIds));
        const claimIds = claims.map(({ id }) => id);
        if (claimIds.length) {
          const tasks = await tx.select({ id: s.tasks.id }).from(s.tasks).where(inArray(s.tasks.claimId, claimIds));
          await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, [...claimIds, ...tasks.map(({ id }) => id)]));
          await tx.delete(s.tasks).where(inArray(s.tasks.claimId, claimIds));
          await tx.delete(s.ruleFires).where(inArray(s.ruleFires.claimId, claimIds));
          await tx.delete(s.claimLines).where(inArray(s.claimLines.claimId, claimIds));
          await tx.delete(s.claims).where(inArray(s.claims.id, claimIds));
        }
        await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, encounterIds));
        await tx.delete(s.encounterMinuteLines).where(inArray(s.encounterMinuteLines.encounterId, encounterIds));
        await tx.delete(s.diagnoses).where(inArray(s.diagnoses.encounterId, encounterIds));
        await tx.delete(s.encounters).where(inArray(s.encounters.id, encounterIds));
        await tx.delete(s.plansOfCare).where(inArray(s.plansOfCare.patientId, [patientId]));
        await tx.delete(s.coverages).where(inArray(s.coverages.patientId, [patientId]));
        await tx.delete(s.patients).where(inArray(s.patients.id, [patientId]));
      });
    } finally { await connection.client.end(); }
  });

  it("lists the scrubbed locked note with 40 computed minutes and three allocated units", async () => {
    const row = (await listOperatorCharts(connection.db, seedOrganization.id)).find(({ encounter }) => encounter.id === encounterId)!;
    expect(row).toMatchObject({ noteId: lockedNoteId, status: "SCRUBBED", units: 3,
      rawMinutes: 40, billableUnionMinutes: 40, overlappingMinutes: 0 });
    expect(row.entries.map(({ cptCode, minutes }) => [cptCode, minutes])).toEqual([["97110", 20], ["97530", 20]]);
    expect(row.entries[0]?.timing).toEqual({ startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z", rawMinutes: 20, performer: "PT", ptaBillableMinutes: 0 });
    expect(row.entries.map(({ performer }) => performer)).toEqual(["PT", "PT"]);
    const detail = await getOperatorChart(connection.db, seedOrganization.id, encounterId);
    expect(detail?.allocation.totalUnits).toBe(3);
    expect(detail?.latestClaim?.status).toBe("SCRUBBED");
    expect(await getOperatorChart(connection.db, seedOrganization.id, baseEncounterId)).toBeNull();
    expect(await getOperatorChart(connection.db, randomUUID(), encounterId)).toBeNull();
  });

  it("reports 40 raw minutes, 30 in the billable union, and previews only 30", async () => {
    const row = (await listOperatorCharts(connection.db, seedOrganization.id))
      .find(({ encounter }) => encounter.id === overlappingEncounterId)!;
    expect(row).toMatchObject({ noteId: overlappingNoteId, status: "SCRUBBED",
      rawMinutes: 40, billableUnionMinutes: 30, overlappingMinutes: 10 });
    expect(row.entries.map(({ cptCode, rawMinutes, billableMinutes }) => [cptCode, rawMinutes, billableMinutes]))
      .toEqual([["97110", 20, 20], ["97140", 20, 10]]);
    const detail = await getOperatorChart(connection.db, seedOrganization.id, overlappingEncounterId);
    expect(detail?.allocation.totalTimedMinutes).toBe(30);
    expect(detail?.allocation.lines.reduce((sum, line) => sum + line.minutes, 0)).toBe(30);
  });

  it("shows the saved PTA performer on the fixture note while the shoulder defaults to PT", async () => {
    const rows = await listOperatorCharts(connection.db, seedOrganization.id);
    const pta = rows.find(({ encounter }) => encounter.id === ptaEncounterId)!;
    const shoulder = rows.find(({ encounter }) => encounter.id === encounterId)!;
    expect(pta.entries.map(({ performer, ptaBillableMinutes }) => [performer, ptaBillableMinutes]))
      .toEqual([["PTA", 20], ["PTA", 2]]);
    expect(shoulder.entries.map(({ performer }) => performer)).toEqual(["PT", "PT"]);
    expect((await getOperatorChart(connection.db, seedOrganization.id, ptaEncounterId))?.entries[0]?.performer)
      .toBe("PTA");
  });
});
