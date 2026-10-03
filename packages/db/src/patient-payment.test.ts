import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import type { EncounterIngestInput } from "@pt-rcm/domain";
import { makeRemitEnvelope } from "../../domain/src/testing/remit.js";
import { createDatabase, postRemit, readPatientInvoice, recordPatientPayment, scrubEncounter,
  submitScrubbedClaim, upsertEncounter } from "./index.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization } from "./seed-data.js";
import * as s from "./schema.js";

const url = process.env.TEST_DATABASE_URL;
const organizationId = seedOrganization.id;
const example = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;

describe.skipIf(!url)("synthetic patient payments", () => {
  let connection: ReturnType<typeof createDatabase>;
  const patientIds: string[] = [];
  beforeAll(async () => { connection = createDatabase(url!); await seedSyntheticData(connection.db); });
  afterAll(async () => {
    if (!connection) return;
    try {
      if (patientIds.length) await connection.db.transaction(async (tx) => {
        const encounterIds = (await tx.select({ id: s.encounters.id }).from(s.encounters)
          .where(inArray(s.encounters.patientId, patientIds))).map((row) => row.id);
        const claimIds = (await tx.select({ id: s.claims.id }).from(s.claims)
          .where(inArray(s.claims.encounterId, encounterIds))).map((row) => row.id);
        const remitIds = (await tx.select({ id: s.remits.id }).from(s.remits)
          .where(inArray(s.remits.claimId, claimIds))).map((row) => row.id);
        await tx.delete(s.auditEvents).where(inArray(s.auditEvents.entityId, [...encounterIds, ...claimIds, ...remitIds]));
        await tx.delete(s.patientPayments).where(inArray(s.patientPayments.claimId, claimIds));
        await tx.delete(s.remitLines).where(inArray(s.remitLines.remitId, remitIds));
        await tx.delete(s.remits).where(inArray(s.remits.claimId, claimIds));
        await tx.delete(s.tasks).where(inArray(s.tasks.claimId, claimIds));
        await tx.delete(s.ruleFires).where(inArray(s.ruleFires.claimId, claimIds));
        await tx.delete(s.claimLines).where(inArray(s.claimLines.claimId, claimIds));
        await tx.delete(s.claims).where(inArray(s.claims.id, claimIds));
        await tx.delete(s.encounterMinuteLines).where(inArray(s.encounterMinuteLines.encounterId, encounterIds));
        await tx.delete(s.diagnoses).where(inArray(s.diagnoses.encounterId, encounterIds));
        await tx.delete(s.encounters).where(inArray(s.encounters.id, encounterIds));
        await tx.delete(s.plansOfCare).where(inArray(s.plansOfCare.patientId, patientIds));
        await tx.delete(s.coverages).where(inArray(s.coverages.patientId, patientIds));
        await tx.delete(s.patients).where(inArray(s.patients.id, patientIds));
      });
    } finally { await connection.client.end(); }
  });

  async function setup() {
    const input = { ...structuredClone(example), externalId: `SYN-PAY-${randomUUID()}`,
      patient: { ...structuredClone(example.patient), externalId: `SYN-PATIENT-${randomUUID()}` },
      minuteLines: [{ cptCode: "97110", minutes: 20 }, { cptCode: "97530", minutes: 20 }] };
    const { patientId, encounterId } = await upsertEncounter(connection.db, organizationId, input);
    patientIds.push(patientId);
    const scrub = await scrubEncounter(connection.db, organizationId, encounterId);
    await submitScrubbedClaim(connection.db, organizationId, scrub.claimId,
      { adapter: "fixture", clearinghouse: new FixtureClearinghouse() });
    const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.id, scrub.claimId));
    const lines = await connection.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, scrub.claimId));
    const envelope = { ...makeRemitEnvelope({ ...claim!, lines }), id: randomUUID() };
    envelope.paidCents = 10800;
    envelope.patientResponsibilityCents = 2700;
    for (const line of envelope.lines) {
      const responsibility = line.paidCents / 5;
      line.paidCents -= responsibility;
      line.patientResponsibilityCents = responsibility;
      line.adjustments = [{ carc: "PR-2", amountCents: responsibility }];
    }
    expect(await postRemit(connection.db, organizationId, envelope)).toMatchObject({ status: "PATIENT_BALANCE", matched: true });
    return claim!.id;
  }

  it("renders itemized 80/20 invoice and keeps a partially paid claim in PATIENT_BALANCE", async () => {
    const claimId = await setup();
    const before = await readPatientInvoice(connection.db, organizationId, claimId);
    expect(before).toMatchObject({ claimId, status: "PATIENT_BALANCE", chargeCents: 13500,
      payerPaidCents: 10800, patientOwedCents: 2700, remainingCents: 2700 });
    expect(before!.lines.map(({ cptCode, chargeCents, payerPaidCents, patientOwedCents }) =>
      ({ cptCode, chargeCents, payerPaidCents, patientOwedCents })).sort((a, b) => a.cptCode.localeCompare(b.cptCode)))
      .toEqual([{ cptCode: "97110", chargeCents: 9000, payerPaidCents: 7200, patientOwedCents: 1800 },
        { cptCode: "97530", chargeCents: 4500, payerPaidCents: 3600, patientOwedCents: 900 }]);

    const paymentId = randomUUID();
    const partial = await recordPatientPayment(connection.db, organizationId, claimId, paymentId, 1000);
    expect(partial).toEqual({ claimId, paymentId, amountCents: 1000, remainingCents: 1700,
      status: "PATIENT_BALANCE", duplicate: false });
    expect((await connection.db.select().from(s.claims).where(eq(s.claims.id, claimId)))[0]!.status).toBe("PATIENT_BALANCE");
    expect(await readPatientInvoice(connection.db, organizationId, claimId)).toMatchObject({ paidByPatientCents: 1000,
      remainingCents: 1700, payments: [{ id: paymentId, amountCents: 1000 }] });
    expect(await connection.db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, claimId))
      .then((events) => events.filter((event) => event.action === "PATIENT_PAYMENT")))
      .toMatchObject([{ detailJson: { paymentId, amountCents: 1000, remainingCents: 1700 } }]);

    const fullId = randomUUID();
    expect(await recordPatientPayment(connection.db, organizationId, claimId, fullId, 1700))
      .toMatchObject({ status: "PAID", remainingCents: 0, duplicate: false });
    expect((await connection.db.select().from(s.claims).where(eq(s.claims.id, claimId)))[0]!.status).toBe("PAID");
    expect(await readPatientInvoice(connection.db, organizationId, claimId)).toMatchObject({ paidByPatientCents: 2700, remainingCents: 0 });
    expect(await recordPatientPayment(connection.db, organizationId, claimId, fullId, 1700))
      .toMatchObject({ status: "PAID", remainingCents: 0, duplicate: true });
    expect(await connection.db.select().from(s.patientPayments).where(eq(s.patientPayments.claimId, claimId))).toHaveLength(2);
    await expect(recordPatientPayment(connection.db, organizationId, claimId, randomUUID(), 1))
      .rejects.toMatchObject({ status: 409, code: "CLAIM_NOT_PAYABLE" });
  });

  it("refuses overpayment, conflicting receipt IDs, invalid cents, and cross-organization access", async () => {
    const claimId = await setup();
    const paymentId = randomUUID();
    await expect(recordPatientPayment(connection.db, organizationId, claimId, paymentId, 2701))
      .rejects.toMatchObject({ status: 422, code: "PAYMENT_EXCEEDS_BALANCE" });
    await expect(recordPatientPayment(connection.db, organizationId, claimId, paymentId, 0))
      .rejects.toMatchObject({ status: 422, code: "INVALID_PAYMENT_AMOUNT" });
    await expect(recordPatientPayment(connection.db, randomUUID(), claimId, paymentId, 100))
      .rejects.toMatchObject({ status: 404, code: "CLAIM_NOT_FOUND" });
    expect(await recordPatientPayment(connection.db, organizationId, claimId, paymentId, 100))
      .toMatchObject({ remainingCents: 2600, status: "PATIENT_BALANCE" });
    await expect(recordPatientPayment(connection.db, organizationId, claimId, paymentId, 101))
      .rejects.toMatchObject({ status: 409, code: "PAYMENT_ID_CONFLICT" });
    expect(await connection.db.select().from(s.patientPayments).where(eq(s.patientPayments.claimId, claimId))).toHaveLength(1);
  });
});
