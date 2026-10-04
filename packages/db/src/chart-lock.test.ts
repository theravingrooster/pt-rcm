import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { createDatabase, lockPtChartNote, scrubEncounter, submitScrubbedClaim, upsertEncounter } from "./index.js";
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
    expect(first).toMatchObject({ created: true, status: "DRAFT" });
    const changed = { ...note, timedEntries: [
      { ...note.timedEntries[0]!, stopTime: "2026-10-01T09:25:00Z" },
      { ...note.timedEntries[1]!, startTime: "2026-10-01T09:25:00Z", stopTime: "2026-10-01T09:45:00Z" },
    ] };
    const second = await lockPtChartNote(connection.db, organizationId, changed);
    expect(second).toMatchObject({ created: false, encounterId: first.encounterId, status: "DRAFT" });
    const minutes = await connection.db.select({ cptCode: s.encounterMinuteLines.cptCode, minutes: s.encounterMinuteLines.minutes })
      .from(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, first.encounterId));
    expect(minutes).toEqual(expect.arrayContaining([
      { cptCode: "97110", minutes: 25 }, { cptCode: "97530", minutes: 20 },
    ]));
    expect(minutes).toHaveLength(2);

    const scrubbed = await scrubEncounter(connection.db, organizationId, first.encounterId);
    expect(scrubbed.status).toBe("SCRUBBED");
    await submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId,
      { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
    const before = await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, first.encounterId));
    await expect(lockPtChartNote(connection.db, organizationId, note)).rejects.toMatchObject({
      status: 409, code: "CLAIM_ALREADY_SUBMITTED",
    });
    expect(await connection.db.select().from(s.encounterMinuteLines)
      .where(eq(s.encounterMinuteLines.encounterId, first.encounterId))).toEqual(before);
  });
});
