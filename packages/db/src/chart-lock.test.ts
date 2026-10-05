import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, lockPtChartNote, submitScrubbedClaim, upsertEncounter } from "./index.js";
import * as s from "./schema.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedFacility, seedOrganization, seedProviders } from "./seed-data.js";

const url = process.env.TEST_DATABASE_URL;
const organizationId = randomUUID();
const facilityId = randomUUID();
const noteId = `SYN-LOCKED-${randomUUID()}`;
const patientExternalId = `SYN-PATIENT-${randomUUID()}`;
const original = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;
const note = {
  externalNoteId: noteId,
  patientExternalId,
  renderingNpi: "0000000003",
  dateOfService: "2026-10-01",
  diagnoses: ["M25.511"],
  timedEntries: [
    { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" },
    { cptCode: "97530", startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z" },
  ],
};
const overlapping = JSON.parse(readFileSync(new URL("../../../fixtures/charts/overlapping-30min.json", import.meta.url), "utf8")) as typeof note;
const pta = JSON.parse(readFileSync(new URL("../../../fixtures/charts/pta-20min.json", import.meta.url), "utf8")) as typeof note;

describe.skipIf(!url)("locked PT chart note ingestion", () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    connection = createDatabase(url!);
    await seedSyntheticData(connection.db);
    await connection.db.insert(s.organizations).values({ ...seedOrganization, id: organizationId });
    await connection.db.insert(s.serviceFacilities).values({ ...seedFacility, id: facilityId, organizationId });
    await connection.db.insert(s.providers).values({ ...seedProviders[0]!, id: randomUUID(), organizationId });
    await upsertEncounter(connection.db, organizationId, {
      ...original, externalId: `SYN-BASE-${randomUUID()}`, facilityId,
      patient: { ...original.patient, externalId: patientExternalId },
    });
  });
  afterAll(async () => {
    if (!connection) return;
    try {
      await connection.db.transaction(async (tx) => {
        const encounters = await tx.select({ id: s.encounters.id }).from(s.encounters).where(eq(s.encounters.organizationId, organizationId));
        const encounterIds = encounters.map(({ id }) => id);
        const claims = await tx.select({ id: s.claims.id }).from(s.claims).where(inArray(s.claims.encounterId, encounterIds));
        const claimIds = claims.map(({ id }) => id);
        if (claimIds.length) {
          await tx.delete(s.ruleFires).where(inArray(s.ruleFires.claimId, claimIds));
          await tx.delete(s.tasks).where(inArray(s.tasks.claimId, claimIds));
          await tx.delete(s.claimLines).where(inArray(s.claimLines.claimId, claimIds));
          await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, claimIds));
          await tx.delete(s.claims).where(inArray(s.claims.id, claimIds));
        }
        await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, encounterIds));
        await tx.delete(s.encounterMinuteLines).where(inArray(s.encounterMinuteLines.encounterId, encounterIds));
        await tx.delete(s.diagnoses).where(inArray(s.diagnoses.encounterId, encounterIds));
        await tx.delete(s.encounters).where(inArray(s.encounters.id, encounterIds));
        const patients = await tx.select({ id: s.patients.id }).from(s.patients).where(eq(s.patients.organizationId, organizationId));
        const patientIds = patients.map(({ id }) => id);
        await tx.delete(s.plansOfCare).where(inArray(s.plansOfCare.patientId, patientIds));
        await tx.delete(s.coverages).where(inArray(s.coverages.patientId, patientIds));
        await tx.delete(s.patients).where(inArray(s.patients.id, patientIds));
        await tx.delete(s.providers).where(eq(s.providers.organizationId, organizationId));
        await tx.delete(s.serviceFacilities).where(eq(s.serviceFacilities.organizationId, organizationId));
        await tx.delete(s.organizations).where(eq(s.organizations.id, organizationId));
      });
    } finally { await connection.client.end(); }
  });

  it("updates the same draft from note timestamps and refuses a repeat lock after fixture submission", async () => {
    const first = await lockPtChartNote(connection.db, organizationId, note);
    expect(first).toMatchObject({ created: true, status: "SCRUBBED", totalUnits: 3,
      rawTotalMinutes: 40, billableUnionMinutes: 40, overlapMinutes: 0, flags: [] });
    const originalClaimLines = await connection.db.select().from(s.claimLines)
      .where(eq(s.claimLines.claimId, first.claimId)).orderBy(s.claimLines.cptCode);
    expect(originalClaimLines.map(({ units, modifiers }) => ({ units, modifiers }))).toEqual([
      { units: 2, modifiers: ["GP"] }, { units: 1, modifiers: ["GP"] },
    ]);
    const [firstClaim] = await connection.db.select().from(s.claims).where(eq(s.claims.encounterId, first.encounterId));
    expect(firstClaim).toMatchObject({ id: first.claimId, status: "SCRUBBED" });
    expect(firstClaim!.snapshotJson.submission).toBeUndefined();
    const firstLines = await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, first.encounterId));
    expect(firstLines.map(({ cptCode, minutes, notes }) => ({ cptCode, minutes, notes: JSON.parse(notes!) })))
      .toEqual(expect.arrayContaining([
        { cptCode: "97110", minutes: 20, notes: {
          source: "SYNTHETIC_LOCKED_PT_NOTE", externalNoteId: noteId,
          startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z",
          performer: "PT",
          ptaBillableMinutes: 0, rawMinutes: 20, billableMinutes: 20, overlapMinutes: 0,
        } },
        { cptCode: "97530", minutes: 20, notes: {
          source: "SYNTHETIC_LOCKED_PT_NOTE", externalNoteId: noteId,
          startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z",
          performer: "PT",
          ptaBillableMinutes: 0, rawMinutes: 20, billableMinutes: 20, overlapMinutes: 0,
        } },
      ]));
    expect(firstLines).toHaveLength(2);
    const changed = { ...note, timedEntries: [
      { ...note.timedEntries[0]!, stopTime: "2026-10-01T09:25:00Z" },
      { ...note.timedEntries[1]!, startTime: "2026-10-01T09:25:00Z", stopTime: "2026-10-01T09:45:00Z" },
    ] };
    const second = await lockPtChartNote(connection.db, organizationId, changed);
    expect(second).toMatchObject({ created: false, encounterId: first.encounterId, status: "SCRUBBED" });
    const minutes = await connection.db.select({ cptCode: s.encounterMinuteLines.cptCode, minutes: s.encounterMinuteLines.minutes })
      .from(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, first.encounterId));
    expect(minutes).toEqual(expect.arrayContaining([
      { cptCode: "97110", minutes: 25 }, { cptCode: "97530", minutes: 20 },
    ]));
    expect(minutes).toHaveLength(2);

    await submitScrubbedClaim(connection.db, organizationId, second.claimId,
      { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
    const before = await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, first.encounterId));
    await expect(lockPtChartNote(connection.db, organizationId, note)).rejects.toMatchObject({
      status: 409, code: "CLAIM_ALREADY_SUBMITTED",
    });
    expect(await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, first.encounterId))).toEqual(before);
  });

  it("adds CQ above ten percent, but not at ten percent, without changing Medicare GP or units", async () => {
    const result = await lockPtChartNote(connection.db, organizationId, {
      ...pta, externalNoteId: `SYN-PTA-${randomUUID()}`, patientExternalId,
    });
    expect(result).toMatchObject({ status: "SCRUBBED", totalUnits: 3, rawTotalMinutes: 40,
      billableUnionMinutes: 40, overlapMinutes: 0 });
    const saved = await connection.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, result.claimId));
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ cptCode: "97110", minutes: 20, modifiers: expect.arrayContaining(["CQ", "GP"]) }),
      expect.objectContaining({ cptCode: "97140", minutes: 20, modifiers: ["GP"] }),
    ]));
    expect(saved.reduce((total, line) => total + line.units, 0)).toBe(3);
    const fires = await connection.db.select().from(s.ruleFires).where(eq(s.ruleFires.claimId, result.claimId));
    expect(fires).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "pta-cq-modifier", outcome: "DOWNGRADE", detailJson: expect.objectContaining({ code: "MISSING_CQ" }) }),
      expect.objectContaining({ ruleId: "gp-modifier", outcome: "DOWNGRADE", detailJson: expect.objectContaining({ code: "MISSING_GP" }) }),
    ]));
    const recorded = await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, result.encounterId));
    expect(recorded.map((line) => ({ cptCode: line.cptCode, notes: JSON.parse(line.notes!) })))
      .toEqual(expect.arrayContaining([
        { cptCode: "97110", notes: expect.objectContaining({ performer: "PTA", billableMinutes: 20, ptaBillableMinutes: 20 }) },
        { cptCode: "97140", notes: expect.objectContaining({ performer: "PTA", billableMinutes: 20, ptaBillableMinutes: 2 }) },
      ]));
  });

  it("allocates the overlap union before adding CQ only to the billed PTA line", async () => {
    const result = await lockPtChartNote(connection.db, organizationId, {
      ...overlapping, externalNoteId: `SYN-OVERLAP-PTA-${randomUUID()}`, patientExternalId,
      timedEntries: [overlapping.timedEntries[0]!, { ...overlapping.timedEntries[1]!, performer: "PTA" }],
      untimedEntries: [{ cptCode: "97161" }],
    });
    expect(result).toMatchObject({ status: "SCRUBBED", rawTotalMinutes: 40,
      billableUnionMinutes: 30, overlapMinutes: 10, flags: ["OVERLAPPING_MINUTES"] });
    const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.id, result.claimId));
    expect(claim?.snapshotJson.allocatedUnits).toMatchObject({ totalTimedMinutes: 30 });
    const saved = await connection.db.select().from(s.claimLines)
      .where(eq(s.claimLines.claimId, result.claimId)).orderBy(s.claimLines.cptCode);
    expect(saved).toEqual([
      expect.objectContaining({ cptCode: "97110", minutes: 20, modifiers: ["GP"] }),
      expect.objectContaining({ cptCode: "97140", minutes: 10,
        modifiers: expect.arrayContaining(["GP", "CQ"]) }),
      expect.objectContaining({ cptCode: "97161", minutes: 0, modifiers: ["GP"] }),
    ]);
    expect(saved.filter((line) => line.modifiers.includes("CQ"))).toHaveLength(1);
  });

  it("credits overlapping 97110 and 97140 only once before the existing allocator runs", async () => {
    const result = await lockPtChartNote(connection.db, organizationId, {
      ...overlapping, externalNoteId: `SYN-OVERLAP-${randomUUID()}`, patientExternalId,
    });
    expect(result).toMatchObject({ status: "SCRUBBED", totalUnits: 2,
      rawTotalMinutes: 40, billableUnionMinutes: 30, overlapMinutes: 10,
      flags: ["OVERLAPPING_MINUTES"] });
    const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.id, result.claimId));
    expect(claim?.snapshotJson.allocatedUnits).toMatchObject({ totalTimedMinutes: 30, totalUnits: 2 });
    expect(claim?.status).toBe("SCRUBBED");
    expect(claim?.snapshotJson.submission).toBeUndefined();
    const lines = await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, result.encounterId));
    expect(lines.map(({ cptCode, minutes, notes }) => ({ cptCode, minutes, notes: JSON.parse(notes!) })))
      .toEqual(expect.arrayContaining([
        { cptCode: "97110", minutes: 20, notes: expect.objectContaining({ rawMinutes: 20,
          billableMinutes: 20, overlapMinutes: 0 }) },
        { cptCode: "97140", minutes: 10, notes: expect.objectContaining({ rawMinutes: 20,
          billableMinutes: 10, overlapMinutes: 10 }) },
      ]));
  });

  it("keeps an untimed eval outside the timed union", async () => {
    const result = await lockPtChartNote(connection.db, organizationId, {
      ...overlapping, externalNoteId: `SYN-OVERLAP-EVAL-${randomUUID()}`, patientExternalId,
      untimedEntries: [{ cptCode: "97161" }],
    });
    expect(result).toMatchObject({ rawTotalMinutes: 40, billableUnionMinutes: 30, totalUnits: 3 });
    const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.id, result.claimId));
    expect(claim?.snapshotJson.allocatedUnits).toMatchObject({ totalTimedMinutes: 30, totalUnits: 3 });
    const lines = await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, result.encounterId));
    expect(lines.find(({ cptCode }) => cptCode === "97161")).toMatchObject({ timed: false, minutes: 0 });
  });

  it("credits a fully contained service zero minutes and keeps the existing zero-minute block", async () => {
    const contained = await lockPtChartNote(connection.db, organizationId, {
      ...overlapping, externalNoteId: `SYN-CONTAINED-${randomUUID()}`, patientExternalId,
      timedEntries: [
        { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:30:00Z" },
        { cptCode: "97140", startTime: "2026-10-01T09:10:00Z", stopTime: "2026-10-01T09:20:00Z" },
      ],
    });
    expect(contained).toMatchObject({ status: "BLOCKED", rawTotalMinutes: 40,
      billableUnionMinutes: 30, overlapMinutes: 10, flags: ["OVERLAPPING_MINUTES"] });
    const lines = await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, contained.encounterId));
    expect(lines.find(({ cptCode }) => cptCode === "97140")).toMatchObject({ minutes: 0, timed: true });
    const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.id, contained.claimId));
    expect(claim?.snapshotJson.allocatedUnits).toMatchObject({ totalTimedMinutes: 30 });
    expect(claim?.snapshotJson.submission).toBeUndefined();
    expect(await connection.db.select().from(s.tasks).where(eq(s.tasks.claimId, contained.claimId)))
      .toEqual([expect.objectContaining({ kind: "RULE_BLOCK", status: "OPEN",
        reason: expect.stringContaining("ZERO_MINUTES") })]);
  });

  it("opens the existing RULE_BLOCK task when the locked note has an unbillable zero-minute service", async () => {
    const blocked = await lockPtChartNote(connection.db, organizationId, {
      ...note, externalNoteId: `SYN-BLOCK-${randomUUID()}`,
      timedEntries: [{ ...note.timedEntries[0]!, stopTime: note.timedEntries[0]!.startTime }],
    });
    expect(blocked).toMatchObject({ status: "BLOCKED", totalUnits: 0 });
    const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.id, blocked.claimId));
    expect(claim?.status).toBe("BLOCKED");
    expect(claim?.snapshotJson.submission).toBeUndefined();
    const tasks = await connection.db.select().from(s.tasks).where(eq(s.tasks.claimId, blocked.claimId));
    expect(tasks).toEqual([expect.objectContaining({ kind: "RULE_BLOCK", owner: "OPERATOR", status: "OPEN",
      reason: expect.stringContaining("ZERO_MINUTES") })]);
  });
});
