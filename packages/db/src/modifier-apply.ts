import { and, desc, eq } from "drizzle-orm";
import { ClaimLineSchema, IdSchema, NonNegativeIntSchema } from "@pt-rcm/domain";
import { suggestDistinctProcedure, type ClaimDraft } from "@pt-rcm/rules";
import type { Database } from "./index.js";
import { encounterSourceFingerprint } from "./encounter-source.js";
import { scrubEncounter } from "./encounter-scrub.js";
import { currentRulePack } from "./rule-packs.js";
import * as s from "./schema.js";

const savedDraftLine = ClaimLineSchema.pick({ cptCode: true, minutes: true, units: true,
  modifiers: true, diagnosisPointers: true }).extend({ units: NonNegativeIntSchema });

export class ModifierApplicationError extends Error {
  constructor(readonly status: 404 | 409 | 422, readonly code: string, message: string) {
    super(message);
    this.name = "ModifierApplicationError";
  }
}

/** Apply exactly the active finding's suggestion and scrub the updated draft atomically. */
export async function applySuggestedModifier(db: Database, organizationId: string, claimId: string) {
  IdSchema.parse(organizationId);
  IdSchema.parse(claimId);
  return db.transaction(async (tx) => {
    const [reference] = await tx.select({ encounterId: s.claims.encounterId }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.claims.id, claimId), eq(s.encounters.organizationId, organizationId)));
    if (!reference) throw new ModifierApplicationError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    // Match scrub and submit's encounter -> claims lock order. A concurrent
    // submit cannot pass the status check while an operator edits this draft.
    const [encounter] = await tx.select().from(s.encounters).where(and(
      eq(s.encounters.id, reference.encounterId), eq(s.encounters.organizationId, organizationId),
    )).for("update");
    if (!encounter) throw new ModifierApplicationError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    const siblings = await tx.select().from(s.claims).where(eq(s.claims.encounterId, encounter.id))
      .orderBy(desc(s.claims.version)).for("update");
    const claim = siblings.find((row) => row.id === claimId);
    if (!claim) throw new ModifierApplicationError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    if (siblings[0]!.id !== claimId) throw new ModifierApplicationError(409, "CLAIM_SUPERSEDED", "Only the latest claim can be edited");
    if (!["DRAFT", "BLOCKED", "SCRUBBED"].includes(claim.status) || encounter.status === "CLAIMED") {
      throw new ModifierApplicationError(409, "MODIFIER_UNAVAILABLE", `A ${claim.status} claim cannot be edited`);
    }

    const { row: ruleSet } = await currentRulePack(tx, "ACTIVE");
    const findings = await tx.select().from(s.ruleFires).where(and(
      eq(s.ruleFires.claimId, claimId), eq(s.ruleFires.ruleSetId, ruleSet.id),
      eq(s.ruleFires.ruleId, "distinct-procedure"), eq(s.ruleFires.shadow, false),
    )).orderBy(desc(s.ruleFires.createdAt), desc(s.ruleFires.id));
    if (!findings.length) {
      throw new ModifierApplicationError(409, "MODIFIER_NOT_SUGGESTED", "No current active modifier 59 suggestion is available");
    }

    const saved = claim.snapshotJson.draftClaim;
    const ids = claim.snapshotJson.claimLineIds;
    if (!saved || typeof saved !== "object" || Array.isArray(saved) || saved.encounterId !== encounter.id
      || !Array.isArray(saved.lines) || !Array.isArray(ids) || saved.lines.length !== ids.length) {
      throw new ModifierApplicationError(422, "DRAFT_LINES_INVALID", "Saved draft line mapping is invalid");
    }
    const parsed = saved.lines.map((line) => savedDraftLine.safeParse(line));
    if (parsed.some((line) => !line.success) || ids.some((id) => id !== null && typeof id !== "string")) {
      throw new ModifierApplicationError(422, "DRAFT_LINES_INVALID", "Saved draft lines are invalid");
    }
    const draftClaim: ClaimDraft = { encounterId: encounter.id, lines: parsed.map((line) => line.data!) };
    const stored = await tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).for("update");
    const billedIds = ids.filter((id): id is string => typeof id === "string");
    if (new Set(billedIds).size !== stored.length || billedIds.length !== stored.length
      || draftClaim.lines.some((line, index) => {
        const id = ids[index];
        if (id === null) return line.units !== 0;
        const row = stored.find((entry) => entry.id === id);
        return !row || (["cptCode", "minutes", "units", "modifiers", "diagnosisPointers"] as const)
          .some((key) => JSON.stringify(row[key]) !== JSON.stringify(line[key]));
      })) {
      throw new ModifierApplicationError(409, "CLAIM_NEEDS_SCRUB", "Draft lines changed; scrub before applying a suggestion");
    }

    const coverages = await tx.select().from(s.coverages).where(and(
      eq(s.coverages.patientId, encounter.patientId), eq(s.coverages.active, true),
    )).for("share");
    const minuteLines = await tx.select().from(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, encounter.id))
      .orderBy(s.encounterMinuteLines.cptCode, s.encounterMinuteLines.id);
    const diagnoses = await tx.select().from(s.diagnoses).where(eq(s.diagnoses.encounterId, encounter.id)).orderBy(s.diagnoses.pointer);
    if (coverages.length !== 1 || claim.snapshotJson.sourceFingerprint !== encounterSourceFingerprint(encounter, coverages[0]!, minuteLines, diagnoses)) {
      throw new ModifierApplicationError(409, "CLAIM_NEEDS_SCRUB", "Encounter inputs changed; scrub before applying a suggestion");
    }

    const suggestion = suggestDistinctProcedure({ draftClaim, minuteLines });
    if (suggestion.outcome !== "FLAG") {
      throw new ModifierApplicationError(409, "MODIFIER_NOT_SUGGESTED", "The saved suggestion is no longer current; scrub again");
    }
    // Timestamp precision can tie rapid scrubs. The pure rule on the unchanged
    // saved draft is authoritative; choose matching evidence from this pack.
    const finding = findings.find(({ outcome, detailJson }) => outcome === "FLAG" && detailJson.code === "MISSING_59"
      && detailJson.suggestedModifier === "59"
      && detailJson.suggestedLineIndex === suggestion.detail.suggestedLineIndex
      && JSON.stringify(detailJson.cptCodes) === JSON.stringify(suggestion.detail.cptCodes));
    if (!finding) throw new ModifierApplicationError(409, "MODIFIER_NOT_SUGGESTED", "The saved suggestion is no longer current; scrub again");
    const lineIndex = suggestion.detail.suggestedLineIndex;
    const lineId = ids[lineIndex];
    const line = stored.find((entry) => entry.id === lineId);
    if (!line || line.cptCode !== suggestion.detail.cptCodes[1]) {
      throw new ModifierApplicationError(409, "MODIFIER_NOT_BILLABLE", "The suggested line has no billable draft line");
    }
    await tx.update(s.claimLines).set({ modifiers: [...line.modifiers, "59"] }).where(eq(s.claimLines.id, line.id));
    // A nested transaction uses a savepoint. Modifier, scrub findings, claim
    // document snapshot and audit either all commit or all roll back.
    const scrub = await scrubEncounter(tx as unknown as Database, organizationId, encounter.id);
    if (scrub.claimId !== claimId) throw new ModifierApplicationError(409, "CLAIM_NEEDS_SCRUB", "The draft claim changed during the operator action");
    await tx.insert(s.auditEvents).values({
      actor: "SYN-OPERATOR", action: "MODIFIER_APPLIED_BY_OPERATOR", entity: "Claim", entityId: claimId,
      at: new Date().toISOString(), detailJson: { encounterId: encounter.id, claimLineId: line.id,
        ruleFireId: finding.id, modifier: "59", cptCodes: suggestion.detail.cptCodes,
        lineIndex, resultStatus: scrub.status },
    });
    return { ...scrub, modifier: "59" as const, cptCodes: suggestion.detail.cptCodes, lineIndex };
  });
}
