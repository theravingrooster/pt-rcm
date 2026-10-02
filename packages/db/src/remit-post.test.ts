import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import { RemitNotPostable, type EncounterIngestInput, type RemitEnvelope } from "@pt-rcm/domain";
import { makeRemitEnvelope } from "../../domain/src/testing/remit.js";
import { createDatabase, listTasks, loadFixtureRemitScripts, pollRemits, postRemit, scrubEncounter, submitScrubbedClaim, upsertEncounter } from "./index.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization, seedPayers } from "./seed-data.js";
import * as s from "./schema.js";
import * as tasks from "./tasks.js";

const url = process.env.TEST_DATABASE_URL;
const organizationId = seedOrganization.id;
const example = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;

describe.skipIf(!url)("transactional remit posting", () => {
  let connection: ReturnType<typeof createDatabase>;
  const patientIds: string[] = [];
  beforeAll(async () => { connection = createDatabase(url!); await seedSyntheticData(connection.db); });
  afterAll(async () => {
    if (!connection) return;
    try {
      if (patientIds.length) await connection.db.transaction(async (tx) => {
        const encounters = await tx.select().from(s.encounters).where(inArray(s.encounters.patientId, patientIds));
        const encounterIds = encounters.map((row) => row.id);
        const claims = await tx.select().from(s.claims).where(inArray(s.claims.encounterId, encounterIds));
        const claimIds = claims.map((row) => row.id);
        if (claimIds.length) {
          const remits = await tx.select().from(s.remits).where(inArray(s.remits.claimId, claimIds));
          const work = await tx.select().from(s.tasks).where(inArray(s.tasks.claimId, claimIds));
          await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, [...claimIds, ...remits.map((row) => row.id), ...work.map((row) => row.id)]));
          if (remits.length) await tx.delete(s.remitLines).where(inArray(s.remitLines.remitId, remits.map((row) => row.id)));
          await tx.delete(s.remits).where(inArray(s.remits.claimId, claimIds));
          await tx.delete(s.tasks).where(inArray(s.tasks.claimId, claimIds));
          await tx.delete(s.ruleFires).where(inArray(s.ruleFires.claimId, claimIds));
          await tx.delete(s.claimLines).where(inArray(s.claimLines.claimId, claimIds));
          await tx.delete(s.claims).where(inArray(s.claims.id, claimIds));
        }
        await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, encounterIds));
        await tx.delete(s.encounterMinuteLines).where(inArray(s.encounterMinuteLines.encounterId, encounterIds));
        await tx.delete(s.diagnoses).where(inArray(s.diagnoses.encounterId, encounterIds));
        await tx.delete(s.encounters).where(inArray(s.encounters.id, encounterIds));
        await tx.delete(s.plansOfCare).where(inArray(s.plansOfCare.patientId, patientIds));
        await tx.delete(s.authorizations).where(inArray(s.authorizations.patientId, patientIds));
        await tx.delete(s.coverages).where(inArray(s.coverages.patientId, patientIds));
        await tx.delete(s.patients).where(inArray(s.patients.id, patientIds));
      });
    } finally { await connection.client.end(); }
  });

  async function setup(visitsUsed = 3) {
    const body = { ...structuredClone(example), externalId: `SYN-REMIT-${randomUUID()}`,
      patient: { ...structuredClone(example.patient), externalId: `SYN-PATIENT-${randomUUID()}` },
      minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }] };
    const { patientId, encounterId } = await upsertEncounter(connection.db, organizationId, body);
    patientIds.push(patientId);
    const [authorization] = await connection.db.insert(s.authorizations).values({ patientId, payerId: seedPayers[0]!.id,
      cptFamily: "SYN-PT", visitsAuthorized: 10, visitsUsed, startDate: "2026-01-01", endDate: "2026-12-31" }).returning();
    await connection.db.update(s.encounters).set({ authorizationId: authorization!.id }).where(eq(s.encounters.id, encounterId));
    const scrubbed = await scrubEncounter(connection.db, organizationId, encounterId);
    await submitScrubbedClaim(connection.db, organizationId, scrubbed.claimId, { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
    const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.id, scrubbed.claimId));
    const lines = await connection.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, scrubbed.claimId)).orderBy(s.claimLines.cptCode);
    const envelope = { ...makeRemitEnvelope({ ...claim!, lines }), id: randomUUID() };
    return { claim: claim!, lines, envelope, authorization: authorization! };
  }
  const post = (envelope: RemitEnvelope) => postRemit(connection.db, organizationId, envelope);
  const used = async (id: string) => (await connection.db.select().from(s.authorizations).where(eq(s.authorizations.id, id)))[0]!.visitsUsed;
  const claimTasks = async (id: string) => (await listTasks(connection.db, organizationId)).filter((task) => task.claimId === id);

  it.each(["PAID", "PATIENT_BALANCE"] as const)("posts %s, traverses acceptance, and decrements authorization once on replay", async (status) => {
    const { claim, lines, envelope, authorization } = await setup();
    if (status === "PATIENT_BALANCE") {
      envelope.paidCents = 10800; envelope.patientResponsibilityCents = 2700;
      envelope.lines.forEach((line) => { line.patientResponsibilityCents = line.paidCents / 5; line.paidCents -= line.patientResponsibilityCents;
        line.adjustments = [{ carc: "PR-2", amountCents: line.patientResponsibilityCents }]; });
    }
    const first = await post(envelope);
    expect(first).toMatchObject({ status, matched: true, duplicate: false, flags: [], authorizationVisitDecremented: true });
    expect(await post(structuredClone(envelope))).toEqual({ ...first, duplicate: true, authorizationVisitDecremented: false });
    expect(await used(authorization.id)).toBe(2);
    const stored = await connection.db.select().from(s.remits).where(eq(s.remits.id, envelope.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ paidCents: envelope.paidCents, patientResponsibilityCents: envelope.patientResponsibilityCents,
      detailJson: { envelope, transitions: ["ACCEPTED", status] } });
    const savedLines = await connection.db.select().from(s.remitLines).where(eq(s.remitLines.remitId, envelope.id));
    expect(savedLines).toHaveLength(2);
    expect(new Set(savedLines.map((line) => line.claimLineId))).toEqual(new Set(lines.map((line) => line.id)));
    expect((await connection.db.select().from(s.claims).where(eq(s.claims.id, claim.id)))[0]!.status).toBe(status);
    expect(await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, envelope.id))).toMatchObject([
      { action: "REMIT_POSTED", detailJson: { transitions: ["ACCEPTED", status], authorizationVisitDecremented: true } },
    ]);
    expect((await claimTasks(claim.id)).map((task) => task.kind)).toEqual(status === "PATIENT_BALANCE" ? ["PATIENT_INVOICE"] : []);
    expect((await loadFixtureRemitScripts(connection.db, organizationId)).some((script) => script.claimId === claim.id)).toBe(false);
  });

  it("posts CO-16 as a denial and contractual adjustment without releasing an authorization visit", async () => {
    const { claim, envelope, authorization } = await setup(); envelope.paidCents = 0;
    envelope.lines.forEach((line) => { line.adjustments = [{ carc: "CO-16", amountCents: line.paidCents }]; line.paidCents = 0; });
    expect(await post(envelope)).toMatchObject({ status: "DENIED", authorizationVisitDecremented: false, flags: [] });
    expect(await used(authorization.id)).toBe(3);
    const rows = await connection.db.select().from(s.remitLines).where(eq(s.remitLines.remitId, envelope.id));
    expect(rows.reduce((sum, row) => sum + row.contractualWriteOffCents, 0)).toBe(13500);
    expect(rows.every((row) => row.patientResponsibilityCents === 0)).toBe(true);
    expect(await claimTasks(claim.id)).toMatchObject([{ kind: "DENIAL_REVIEW", owner: "OPERATOR" }]);
  });

  it("posts unbalanced numbers and a persisted FLAG, with an operator task", async () => {
    const { claim, envelope } = await setup(); envelope.paidCents -= 1; envelope.lines[0]!.paidCents -= 1;
    expect(await post(envelope)).toMatchObject({ status: "PAID", flags: [{ code: "REMIT_OUT_OF_BALANCE", outcome: "FLAG" }] });
    expect((await connection.db.select().from(s.remits).where(eq(s.remits.id, envelope.id)))[0]).toMatchObject({ paidCents: 13499,
      detailJson: { result: { flags: [{ code: "REMIT_OUT_OF_BALANCE" }] } } });
    expect((await connection.db.select().from(s.remitLines).where(eq(s.remitLines.remitId, envelope.id))).map((line) => line.paidCents).sort((a, b) => a - b)).toEqual([4500, 8999]);
    expect(await claimTasks(claim.id)).toMatchObject([{ kind: "REMIT_OUT_OF_BALANCE", owner: "OPERATOR" }]);
  });

  it("retains an ambiguous remit without guessing, advancing state, or releasing a visit", async () => {
    const { claim, lines, envelope, authorization } = await setup();
    await connection.db.update(s.claimLines).set({ cptCode: lines[0]!.cptCode, units: lines[0]!.units }).where(eq(s.claimLines.id, lines[1]!.id));
    expect(await post(envelope)).toMatchObject({ matched: false, status: "SUBMITTED", authorizationVisitDecremented: false });
    expect(await post(envelope)).toMatchObject({ duplicate: true, matched: false });
    expect(await used(authorization.id)).toBe(3);
    expect(await claimTasks(claim.id)).toMatchObject([{ kind: "REMIT_UNMATCHED", owner: "OPERATOR" }]);
    expect(await connection.db.select().from(s.remitLines).where(eq(s.remitLines.remitId, envelope.id))).toEqual([]);
    expect((await connection.db.select().from(s.remits).where(eq(s.remits.id, envelope.id)))[0]!.detailJson.envelope).toEqual(envelope);
  });

  it("serializes concurrent duplicates to one posting and one authorization decrement", async () => {
    const { envelope, authorization } = await setup();
    const results = await Promise.all([post(envelope), post(envelope)]);
    expect(results.filter((row) => row.duplicate)).toHaveLength(1);
    expect(results.filter((row) => row.authorizationVisitDecremented)).toHaveLength(1);
    expect(await used(authorization.id)).toBe(2);
    expect(await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, envelope.id))).toHaveLength(1);
  });

  it("does not make visitsUsed negative", async () => {
    const { envelope, authorization } = await setup(0);
    expect(await post(envelope)).toMatchObject({ status: "PAID", authorizationVisitDecremented: false });
    expect(await used(authorization.id)).toBe(0);
  });

  it("rejects conflicting remit IDs and additional remits for terminal claims", async () => {
    const { envelope, authorization } = await setup(); await post(envelope);
    await expect(post({ ...envelope, paidCents: 1 })).rejects.toMatchObject({ status: 409, code: "REMIT_ID_CONFLICT" });
    await expect(post({ ...envelope, id: randomUUID() })).rejects.toBeInstanceOf(RemitNotPostable);
    expect(await used(authorization.id)).toBe(2);
  });

  it("rejects out-of-scope claims and adapter selection before calling the port", async () => {
    const { envelope } = await setup();
    await expect(postRemit(connection.db, randomUUID(), envelope)).rejects.toMatchObject({ status: 404 });
    const clearinghouse = new FixtureClearinghouse();
    await expect(pollRemits(connection.db, organizationId, "2026-01-01", { adapter: "stedi", clearinghouse })).rejects.toMatchObject({ status: 503 });
    expect(clearinghouse.calls).toEqual([]);
  });

  it("rolls back lifecycle and tasks if task persistence fails, then allows retry", async () => {
    const { claim, envelope, authorization } = await setup(); envelope.paidCents = 0;
    envelope.lines.forEach((line) => { line.adjustments = [{ carc: "CO-16", amountCents: line.paidCents }]; line.paidCents = 0; });
    const original = tasks.openClaimTask;
    const spy = vi.spyOn(tasks, "openClaimTask").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("SYN posting failure"); });
    try { await expect(post(envelope)).rejects.toThrow("SYN posting failure"); } finally { spy.mockRestore(); }
    expect((await connection.db.select().from(s.claims).where(eq(s.claims.id, claim.id)))[0]!.status).toBe("SUBMITTED");
    expect(await claimTasks(claim.id)).toEqual([]);
    expect(await connection.db.select().from(s.remits).where(eq(s.remits.id, envelope.id))).toEqual([]);
    expect(await used(authorization.id)).toBe(3);
    expect((await post(envelope)).status).toBe("DENIED");
  });

  it("polls submitted fixture documents, replays stable receipts after restart, and never submits", async () => {
    const { claim, authorization } = await setup();
    const scripts = (await loadFixtureRemitScripts(connection.db, organizationId)).filter((script) => script.claimId === claim.id);
    expect(scripts).toHaveLength(1);
    expect(await loadFixtureRemitScripts(connection.db, randomUUID())).toEqual([]);
    const fixture = new FixtureClearinghouse(scripts);
    const first = await pollRemits(connection.db, organizationId, "1970-01-01", { adapter: "fixture", clearinghouse: fixture });
    expect(first.results).toMatchObject([{ status: "PATIENT_BALANCE", duplicate: false }]);
    const repeatScripts = (await loadFixtureRemitScripts(connection.db, organizationId)).filter((script) => script.claimId === claim.id);
    const repeat = await pollRemits(connection.db, organizationId, "1970-01-01", { adapter: "fixture", clearinghouse: new FixtureClearinghouse(repeatScripts) });
    expect(repeat.results).toMatchObject([{ remitId: first.results[0]!.remitId, status: "PATIENT_BALANCE", duplicate: true }]);
    expect(await used(authorization.id)).toBe(2);
    expect(fixture.calls).toEqual([{ method: "fetchRemits", since: "1970-01-01" }]);
  });
});
