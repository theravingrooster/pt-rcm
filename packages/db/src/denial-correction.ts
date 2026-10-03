import { and, desc, eq } from "drizzle-orm";
import { ClaimLineSchema, IdSchema, fixtureLineChargeCents } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { encounterSourceFingerprint } from "./encounter-source.js";
import { scrubEncounter } from "./encounter-scrub.js";
import * as s from "./schema.js";

export class DenialCorrectionError extends Error {
  constructor(readonly status: 404 | 409 | 422, readonly code: string, message: string) {
    super(message);
    this.name = "DenialCorrectionError";
  }
}

export type DeniedClaimLineEdit = { claimLineId: string; units: number; modifiers: string[] };

/** Review every billable line of the latest denied claim, then run the active
 * scrub in the same transaction. Only the operator's units and modifiers can
 * change; source codes, minutes, diagnoses and line identities remain fixed.
 * A blocked retry stays DENIED and cannot pass the fixture submit gate.
 */
export async function correctDeniedClaim(db: Database, organizationId: string, claimId: string, edits: DeniedClaimLineEdit[]) {
  IdSchema.parse(organizationId);
  IdSchema.parse(claimId);
  if (!Array.isArray(edits) || edits.length === 0 || edits.some((edit) => !edit || !IdSchema.safeParse(edit.claimLineId).success
    || !ClaimLineSchema.shape.units.safeParse(edit.units).success
    || !ClaimLineSchema.shape.modifiers.safeParse(edit.modifiers).success)) {
    throw new DenialCorrectionError(422, "INVALID_CORRECTION", "Supply valid units and modifiers for every billable claim line");
  }
  return db.transaction(async (tx) => {
    const [reference] = await tx.select({ encounterId: s.claims.encounterId }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.claims.id, claimId), eq(s.encounters.organizationId, organizationId)));
    if (!reference) throw new DenialCorrectionError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    // Keep encounter -> claim -> claim-line lock order used by scrub and submit.
    const [encounter] = await tx.select().from(s.encounters).where(and(
      eq(s.encounters.id, reference.encounterId), eq(s.encounters.organizationId, organizationId),
    )).for("update");
    const siblings = await tx.select().from(s.claims).where(eq(s.claims.encounterId, encounter!.id))
      .orderBy(desc(s.claims.version)).for("update");
    const claim = siblings.find((row) => row.id === claimId);
    if (!claim || siblings[0]!.id !== claimId) {
      throw new DenialCorrectionError(409, "CLAIM_SUPERSEDED", "Only the latest claim can be corrected");
    }
    if (claim.status !== "DENIED") {
      throw new DenialCorrectionError(409, "CORRECTION_UNAVAILABLE", `A ${claim.status} claim cannot be corrected as a denial`);
    }
    const stored = await tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).for("update");
    const ids = claim.snapshotJson.claimLineIds;
    const saved = claim.snapshotJson.draftClaim;
    if (!Array.isArray(ids) || ids.some((id) => id !== null && typeof id !== "string")
      || !saved || typeof saved !== "object" || Array.isArray(saved) || saved.encounterId !== encounter!.id
      || !Array.isArray(saved.lines) || saved.lines.length !== ids.length
      || ids.filter((id) => id !== null).length !== stored.length
      || new Set(ids.filter((id) => id !== null)).size !== stored.length) {
      throw new DenialCorrectionError(409, "DRAFT_LINES_INVALID", "Saved claim line mapping is invalid");
    }
    for (const [index, id] of ids.entries()) {
      const reviewed = saved.lines[index];
      if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) {
        throw new DenialCorrectionError(409, "DRAFT_LINES_INVALID", "Saved claim lines are invalid");
      }
      if (id === null) {
        if (reviewed.units !== 0) throw new DenialCorrectionError(409, "DRAFT_LINES_INVALID", "A zero-unit line was changed");
        continue;
      }
      const line = stored.find((row) => row.id === id);
      if (!line || (["cptCode", "minutes", "units", "modifiers", "diagnosisPointers"] as const)
        .some((key) => JSON.stringify(line[key]) !== JSON.stringify(reviewed[key]))) {
        throw new DenialCorrectionError(409, "CLAIM_NEEDS_SCRUB", "Saved claim lines changed since the last scrub");
      }
    }
    const editIds = edits.map((edit) => edit.claimLineId);
    if (editIds.length !== stored.length || new Set(editIds).size !== stored.length
      || editIds.some((id) => !stored.some((line) => line.id === id))) {
      throw new DenialCorrectionError(422, "INVALID_CORRECTION", "Supply each existing billable claim line exactly once");
    }
    const coverages = await tx.select().from(s.coverages).where(and(
      eq(s.coverages.patientId, encounter!.patientId), eq(s.coverages.active, true),
    )).for("share");
    const minutes = await tx.select().from(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, encounter!.id))
      .orderBy(s.encounterMinuteLines.cptCode, s.encounterMinuteLines.id);
    const diagnoses = await tx.select().from(s.diagnoses).where(eq(s.diagnoses.encounterId, encounter!.id)).orderBy(s.diagnoses.pointer);
    if (coverages.length !== 1 || claim.snapshotJson.sourceFingerprint !== encounterSourceFingerprint(encounter!, coverages[0]!, minutes, diagnoses)) {
      throw new DenialCorrectionError(409, "CLAIM_SOURCE_CHANGED", "The denied claim source changed; review it before correction");
    }
    const changes = edits.flatMap((edit) => {
      const line = stored.find((row) => row.id === edit.claimLineId)!;
      return line.units !== edit.units || JSON.stringify(line.modifiers) !== JSON.stringify(edit.modifiers)
        ? [{ claimLineId: line.id, cptCode: line.cptCode, from: { units: line.units, modifiers: line.modifiers },
          to: { units: edit.units, modifiers: edit.modifiers } }] : [];
    });
    if (!changes.length) throw new DenialCorrectionError(422, "NO_CORRECTION", "Change at least one line before re-scrubbing a denial");
    for (const edit of edits) {
      const line = stored.find((row) => row.id === edit.claimLineId)!;
      await tx.update(s.claimLines).set({ units: edit.units, modifiers: edit.modifiers,
        chargeCents: fixtureLineChargeCents(line.cptCode, edit.units) }).where(eq(s.claimLines.id, line.id));
    }
    // Nested transaction is a savepoint: the correction, active findings, claim
    // snapshot, task and audit commit together, including a blocked result.
    const scrub = await scrubEncounter(tx as unknown as Database, organizationId, encounter!.id);
    if (scrub.claimId !== claimId) throw new DenialCorrectionError(409, "CLAIM_SOURCE_CHANGED", "The corrected claim changed during re-scrub");
    await tx.insert(s.auditEvents).values({ actor: "SYN-OPERATOR", action: "DENIED_CLAIM_CORRECTED_BY_OPERATOR",
      entity: "Claim", entityId: claimId, at: new Date().toISOString(),
      detailJson: { encounterId: encounter!.id, changes, resultStatus: scrub.status, version: scrub.version },
    });
    return scrub;
  });
}
