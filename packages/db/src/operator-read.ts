import { and, desc, eq, inArray } from "drizzle-orm";
import { allocateUnits, ClaimDocumentSchema, IdSchema, loadMedicareMinuteLadder, renderClaimDocumentJson, type Claim, type RuleFire } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { ClaimDocumentReadError, readClaimDocument } from "./claim-document.js";
import * as s from "./schema.js";

type Reader = Pick<Database, "select">;
const readOnly = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

async function latestFindings(db: Reader, claimIds: string[]) {
  if (!claimIds.length) return [];
  const rows = await db.select().from(s.ruleFires).where(inArray(s.ruleFires.claimId, claimIds))
    .orderBy(desc(s.ruleFires.createdAt), desc(s.ruleFires.id));
  const latest = new Map<string, RuleFire>();
  for (const row of rows) {
    const key = `${row.claimId}:${row.ruleId}:${row.shadow}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

async function documentPreview(db: Reader, organizationId: string, claim: Claim | undefined) {
  if (!claim) return { json: null, source: null, message: "Scrub the encounter to create its first claim document." };
  if (claim.status === "SCRUBBED") {
    try {
      return { json: renderClaimDocumentJson(await readClaimDocument(db, organizationId, claim.id)), source: "Scrubbed claim", message: null };
    } catch (error) {
      if (error instanceof ClaimDocumentReadError) return { json: null, source: null, message: "The saved claim document is inconsistent. Review the claim and scrub it again." };
      throw error;
    }
  }
  const receipt = claim.snapshotJson.submission;
  const saved = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? ClaimDocumentSchema.safeParse(receipt.document) : null;
  if (saved?.success && saved.data.claimId === claim.id && saved.data.claimVersion === claim.version) {
    return { json: renderClaimDocumentJson(saved.data), source: "Submitted document snapshot", message: null };
  }
  return { json: null, source: null, message: `A ${claim.status} claim has no submittable document. Resolve any blocks and scrub it first.` };
}

/** Read models only: viewing a page never runs policy rules or persists changes. */
export async function listOperatorEncounters(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  return db.transaction(async (tx) => {
    const rows = await tx.select({ encounter: s.encounters, patient: s.patients }).from(s.encounters)
      .innerJoin(s.patients, eq(s.patients.id, s.encounters.patientId))
      .where(eq(s.encounters.organizationId, organizationId)).orderBy(desc(s.encounters.dateOfService), s.encounters.externalId);
    if (!rows.length) return [];
    const ids = rows.map((row) => row.encounter.id);
    const [claims, minutes] = await Promise.all([
      tx.selectDistinctOn([s.claims.encounterId]).from(s.claims).where(inArray(s.claims.encounterId, ids)).orderBy(s.claims.encounterId, desc(s.claims.version)),
      tx.select().from(s.encounterMinuteLines).where(inArray(s.encounterMinuteLines.encounterId, ids)).orderBy(s.encounterMinuteLines.cptCode, s.encounterMinuteLines.id),
    ]);
    const claimIds = claims.map((claim) => claim.id);
    const [lines, findings] = await Promise.all([
      claimIds.length ? tx.select().from(s.claimLines).where(inArray(s.claimLines.claimId, claimIds)) : Promise.resolve([]),
      latestFindings(tx, claimIds),
    ]);
    const byEncounter = new Map(claims.map((claim) => [claim.encounterId, claim]));
    return rows.map(({ encounter, patient }) => {
      const claim = byEncounter.get(encounter.id);
      const units = claim ? lines.filter((line) => line.claimId === claim.id).reduce((sum, line) => sum + line.units, 0)
        : allocateUnits(minutes.filter((line) => line.encounterId === encounter.id), loadMedicareMinuteLadder()).totalUnits;
      return { encounter, patient, claim: claim ?? null, units, unitsSource: claim ? "Claim" : "Allocation preview",
        blocks: findings.filter((finding) => finding.claimId === claim?.id && !finding.shadow && finding.outcome === "BLOCK").length };
    });
  }, readOnly);
}

export async function getOperatorEncounter(db: Database, organizationId: string, encounterId: string) {
  IdSchema.parse(organizationId); IdSchema.parse(encounterId);
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ encounter: s.encounters, patient: s.patients, provider: s.providers, facility: s.serviceFacilities }).from(s.encounters)
      .innerJoin(s.patients, eq(s.patients.id, s.encounters.patientId)).innerJoin(s.providers, eq(s.providers.id, s.encounters.renderingProviderId))
      .innerJoin(s.serviceFacilities, eq(s.serviceFacilities.id, s.encounters.facilityId))
      .where(and(eq(s.encounters.id, encounterId), eq(s.encounters.organizationId, organizationId)));
    if (!row) return null;
    const [minuteLines, diagnoses, claims] = await Promise.all([
      tx.select().from(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, encounterId)).orderBy(s.encounterMinuteLines.cptCode, s.encounterMinuteLines.id),
      tx.select().from(s.diagnoses).where(eq(s.diagnoses.encounterId, encounterId)).orderBy(s.diagnoses.pointer),
      tx.select().from(s.claims).where(eq(s.claims.encounterId, encounterId)).orderBy(desc(s.claims.version)),
    ]);
    const latest = claims[0];
    const [findings, document] = await Promise.all([latestFindings(tx, latest ? [latest.id] : []), documentPreview(tx, organizationId, latest)]);
    return { ...row, minuteLines, diagnoses, claims, latestClaim: latest ?? null,
      allocation: allocateUnits(minuteLines, loadMedicareMinuteLadder()), findings, document };
  }, readOnly);
}

export async function listOperatorTasks(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  return db.select({ task: s.tasks, claim: s.claims, encounter: s.encounters, patient: s.patients }).from(s.tasks)
    .innerJoin(s.claims, eq(s.claims.id, s.tasks.claimId)).innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
    .innerJoin(s.patients, eq(s.patients.id, s.encounters.patientId))
    .where(and(eq(s.encounters.organizationId, organizationId), eq(s.tasks.status, "OPEN")))
    .orderBy(s.tasks.kind, s.encounters.dateOfService, s.tasks.id);
}

export async function getOperatorClaim(db: Database, organizationId: string, claimId: string) {
  IdSchema.parse(organizationId); IdSchema.parse(claimId);
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ claim: s.claims, encounter: s.encounters, patient: s.patients, payer: s.payers }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId)).innerJoin(s.patients, eq(s.patients.id, s.encounters.patientId))
      .innerJoin(s.payers, eq(s.payers.id, s.claims.payerId))
      .where(and(eq(s.claims.id, claimId), eq(s.encounters.organizationId, organizationId)));
    if (!row) return null;
    const [lines, remits, remitLines, document] = await Promise.all([
      tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).orderBy(s.claimLines.cptCode, s.claimLines.id),
      tx.select().from(s.remits).where(eq(s.remits.claimId, claimId)).orderBy(desc(s.remits.receivedOn), s.remits.id),
      tx.select({ remitLine: s.remitLines, claimLine: s.claimLines }).from(s.remitLines)
        .innerJoin(s.remits, eq(s.remits.id, s.remitLines.remitId)).innerJoin(s.claimLines, eq(s.claimLines.id, s.remitLines.claimLineId))
        .where(eq(s.remits.claimId, claimId)).orderBy(s.remitLines.remitId, s.claimLines.cptCode, s.remitLines.id),
      documentPreview(tx, organizationId, row.claim),
    ]);
    const receipt = row.claim.snapshotJson.submission;
    const ack = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt.acknowledgment : null;
    const icn = ack && typeof ack === "object" && !Array.isArray(ack) && typeof ack.icn === "string" ? ack.icn : null;
    return { ...row, lines, remits, remitLines, document, icn };
  }, readOnly);
}
