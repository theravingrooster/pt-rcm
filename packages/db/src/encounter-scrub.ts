import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { allocateUnits, AuthorizationSchema, ClaimLineSchema, CoverageSchema, EncounterMinuteLineSchema, EncounterSchema,
  fixtureLineChargeCents, IdSchema, JsonObjectSchema, loadMedicareMinuteLadder, MoneyCentsSchema, PayerSchema,
  PlanOfCareSchema, type Claim } from "@pt-rcm/domain";
import { applyDowngrades, runRulesWithRepository, type ClaimDraft, type RuleContext } from "@pt-rcm/rules";
import type { Database } from "./index.js";
import { createRuleFireRepository } from "./rule-fire-repository.js";
import * as s from "./schema.js";
import { encounterSourceFingerprint } from "./encounter-source.js";
import { persistClaimTransition } from "./claim-lifecycle.js";
import { openClaimTask } from "./tasks.js";
import { currentRulePack } from "./rule-packs.js";

export class EncounterScrubError extends Error {
  constructor(readonly status: 404 | 409 | 422, readonly code: string, message: string) {
    super(message);
    this.name = "EncounterScrubError";
  }
}

/**
 * Scrub only; no submission capability. Lock the encounter before its claims,
 * matching ingestion's lock order. Claim, lines, snapshot and RuleFires commit
 * together. Re-scrubs retain stored units/modifiers instead of masking overbilling
 * by reallocating them. An edited encounter creates a new claim version.
 */
export async function scrubEncounter(db: Database, organizationId: string, encounterId: string) {
  IdSchema.parse(organizationId);
  IdSchema.parse(encounterId);
  return db.transaction(async (tx) => {
    const [encounter] = await tx.select().from(s.encounters).where(and(
      eq(s.encounters.id, encounterId), eq(s.encounters.organizationId, organizationId),
    )).for("update");
    if (!encounter) throw new EncounterScrubError(404, "ENCOUNTER_NOT_FOUND", "Encounter not found in this organization");
    const previous = await tx.select().from(s.claims).where(eq(s.claims.encounterId, encounterId)).orderBy(desc(s.claims.version)).for("update");
    const latest = previous[0];
    const deniedRetry = latest?.status === "DENIED";
    const preSubmission = new Set(["DRAFT", "SCRUBBED", "BLOCKED"]);
    if (previous.some((claim) => !preSubmission.has(claim.status) && !(claim.id === latest?.id && deniedRetry))
      || (encounter.status === "CLAIMED" && !deniedRetry)) {
      throw new EncounterScrubError(409, "CLAIM_ALREADY_SUBMITTED", "A submitted claim cannot be scrubbed or replaced");
    }
    const coverages = await tx.select().from(s.coverages).where(and(eq(s.coverages.patientId, encounter.patientId), eq(s.coverages.active, true)));
    // The current encounter model has no coverage selector. Do not guess between
    // multiple active payers; a future coordination-of-benefits flow must select one.
    if (coverages.length !== 1) throw new EncounterScrubError(422, "COVERAGE_NOT_UNIQUE", "Exactly one active coverage is required for this fixture scrub");
    const coverage = coverages[0]!;
    const [payer] = await tx.select().from(s.payers).where(eq(s.payers.id, coverage.payerId));
    if (!payer) throw new EncounterScrubError(422, "PAYER_NOT_FOUND", "Coverage payer is unavailable");
    const minuteLines = await tx.select().from(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, encounterId))
      .orderBy(s.encounterMinuteLines.cptCode, s.encounterMinuteLines.id);
    const diagnoses = await tx.select().from(s.diagnoses).where(eq(s.diagnoses.encounterId, encounterId)).orderBy(s.diagnoses.pointer);
    const allocatedUnits = allocateUnits(minuteLines, loadMedicareMinuteLadder());
    const sourceFingerprint = encounterSourceFingerprint(encounter, coverage, minuteLines, diagnoses);
    if (latest && typeof latest.snapshotJson.sourceFingerprint !== "string") {
      throw new EncounterScrubError(409, "DRAFT_SOURCE_UNKNOWN", "Existing draft has no source mapping; review it before scrubbing");
    }
    const reuse = latest?.snapshotJson.sourceFingerprint === sourceFingerprint;
    // A denial revision keeps the claim identity. Changed clinical source data
    // needs an explicit correction workflow; never replace DENIED with a new DRAFT.
    if (deniedRetry && !reuse) throw new EncounterScrubError(409, "CLAIM_SOURCE_CHANGED", "Denied claim source changed; review the correction before re-scrubbing");
    const claimId = reuse ? latest!.id : randomUUID();
    const version = reuse ? latest!.version : (latest?.version ?? 0) + 1;
    let draftClaim: ClaimDraft = { encounterId, lines: allocatedUnits.lines.map(({ cptCode, minutes, units }) => ({
      cptCode, minutes, units, modifiers: [], diagnosisPointers: diagnoses.map((diagnosis) => diagnosis.pointer),
    })) };
    let claimLineIds: (string | null)[] = draftClaim.lines.map((line) => line.units > 0 ? randomUUID() : null);
    if (reuse) {
      const stored = await tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).for("update");
      const ids = latest!.snapshotJson.claimLineIds;
      if (!Array.isArray(ids) || ids.length !== minuteLines.length || ids.some((id) => id !== null && typeof id !== "string")
        || ids.filter((id) => id !== null).length !== stored.length
        || new Set(ids.filter((id) => id !== null)).size !== stored.length) {
        throw new EncounterScrubError(409, "DRAFT_LINES_INVALID", "Stored draft line mapping is invalid");
      }
      claimLineIds = ids as (string | null)[];
      draftClaim = { encounterId, lines: draftClaim.lines.map((line, index) => {
        const id = claimLineIds[index];
        const saved = stored.find((row) => row.id === id);
        if (id === null && line.units === 0) return line;
        if (!saved || saved.cptCode !== line.cptCode || saved.minutes !== line.minutes
          || JSON.stringify(saved.diagnosisPointers) !== JSON.stringify(line.diagnosisPointers)) {
          throw new EncounterScrubError(409, "DRAFT_LINES_INVALID", "Stored draft must preserve recorded services, minutes, and diagnoses");
        }
        return { ...line, units: saved.units, modifiers: saved.modifiers };
      }) };
    }
    const price = (draft: ClaimDraft) => MoneyCentsSchema.parse(draft.lines.reduce((sum, line) => sum + fixtureLineChargeCents(line.cptCode, line.units), 0));
    const claimChargeCents = price(draftClaim);
    const authorizations = await tx.select().from(s.authorizations).where(and(
      eq(s.authorizations.patientId, encounter.patientId), eq(s.authorizations.payerId, payer.id),
    ));
    const plans = await tx.select().from(s.plansOfCare).where(eq(s.plansOfCare.patientId, encounter.patientId))
      .orderBy(desc(s.plansOfCare.signedDate), s.plansOfCare.id);
    const planOfCare = plans.find((plan) => plan.signedDate <= encounter.dateOfService) ?? plans[0] ?? null;
    // Recorded billed charges only, through this DOS in this service year. Keep
    // the latest submitted version per encounter so revisions are not counted twice.
    const billed = await tx.selectDistinctOn([s.claims.encounterId], { cents: s.claims.totalChargeCents })
      .from(s.claims).innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId)).where(and(
        eq(s.encounters.organizationId, organizationId), eq(s.encounters.patientId, encounter.patientId),
        eq(s.claims.payerId, payer.id), ne(s.encounters.id, encounterId),
        gte(s.encounters.dateOfService, `${encounter.dateOfService.slice(0, 4)}-01-01`), lte(s.encounters.dateOfService, encounter.dateOfService),
        inArray(s.claims.status, ["SUBMITTED", "ACCEPTED", "REJECTED", "PAID", "DENIED", "PATIENT_BALANCE"]),
      )).orderBy(s.claims.encounterId, desc(s.claims.version));
    const yearToDateBilledCents = MoneyCentsSchema.parse(billed.reduce((sum, row) => sum + row.cents, 0));
    const ctx: RuleContext = { encounter, minuteLines, allocatedUnits, draftClaim, claimChargeCents,
      coverage, payer, authorizations, planOfCare, yearToDateBilledCents, mode: "active" };
    const current: Claim = reuse ? latest! : { id: claimId, encounterId, version, status: "DRAFT", payerId: payer.id, totalChargeCents: claimChargeCents, snapshotJson: {} };
    if (!reuse) await tx.insert(s.claims).values(current);
    const { row: ruleSet, pack } = await currentRulePack(tx, "ACTIVE");
    const run = await runRulesWithRepository(pack.rules, ctx, { claimId, repository: createRuleFireRepository(tx, ruleSet.id) });
    const applied = applyDowngrades(draftClaim, run.downgrades);
    // A failed denial retry remains DENIED: there is no DENIED -> BLOCKED edge.
    // Repeated scrubs with the same result are no-ops, not self-transitions.
    const target = run.submissionAllowed ? "SCRUBBED" : deniedRetry ? "DENIED" : "BLOCKED";
    const next = current.status === target ? current : await persistClaimTransition(tx, current, target);
    if (!run.submissionAllowed) await openClaimTask(tx, claimId, "RULE_BLOCK", run.blocks.map((block) => `${block.code}: ${block.message}`).join("; "));
    if (deniedRetry && run.submissionAllowed) await tx.update(s.encounters).set({ status: "DRAFT" }).where(eq(s.encounters.id, encounterId));
    const totalChargeCents = price(applied);
    for (const [index, line] of applied.lines.entries()) {
      // The canonical ClaimLine requires positive units. Keep all zero-unit
      // services in the snapshot and rule context, never invent a billable unit.
      if (line.units === 0) continue;
      const values = { ...line, modifiers: [...line.modifiers], diagnosisPointers: [...line.diagnosisPointers], chargeCents: fixtureLineChargeCents(line.cptCode, line.units) };
      if (reuse) await tx.update(s.claimLines).set(values).where(and(eq(s.claimLines.id, claimLineIds[index]!), eq(s.claimLines.claimId, claimId)));
      else await tx.insert(s.claimLines).values({ id: claimLineIds[index]!, claimId, ...values });
    }
    // Retain prior fixture receipts when a rejected/denied claim is corrected.
    // On a failed denial retry the current receipt remains current.
    const submission = latest?.snapshotJson.submission;
    const history = latest?.snapshotJson.submissionHistory;
    const submissionHistory = [...(Array.isArray(history) ? history : []),
      ...(submission && next.status !== "DENIED" ? [{ version: latest!.version, submission }] : [])];
    await tx.update(s.claims).set({ totalChargeCents, snapshotJson: JsonObjectSchema.parse({
      sourceFingerprint, claimLineIds, rulePack: { id: pack.id, version: pack.version, mode: "active" },
      encounter, minuteLines, diagnoses, coverage, payer, authorizations, planOfCare,
      yearToDateBilledCents, allocatedUnits, evaluatedDraft: draftClaim, draftClaim: applied,
      submissionHistory, ...(submission && next.status === "DENIED" ? { submission } : {}),
    }) }).where(eq(s.claims.id, claimId));
    return { encounterId, claimId, version: next.version, status: next.status, totalChargeCents,
      totalUnits: applied.lines.reduce((sum, line) => sum + line.units, 0), lines: applied.lines, ...run };
  });
}

const savedDraftLine = ClaimLineSchema.pick({ cptCode: true, minutes: true, units: true,
  modifiers: true, diagnosisPointers: true });

/** Evaluate the candidate against the saved active scrub input, recording only audit rows. */
export async function shadowScrubEncounter(db: Database, organizationId: string, encounterId: string) {
  IdSchema.parse(organizationId); IdSchema.parse(encounterId);
  return db.transaction(async (tx) => {
    const [encounter] = await tx.select().from(s.encounters).where(and(
      eq(s.encounters.id, encounterId), eq(s.encounters.organizationId, organizationId),
    )).for("share");
    if (!encounter) throw new EncounterScrubError(404, "ENCOUNTER_NOT_FOUND", "Encounter not found in this organization");
    const [claim] = await tx.select().from(s.claims).where(eq(s.claims.encounterId, encounterId))
      .orderBy(desc(s.claims.version)).limit(1).for("share");
    if (!claim) throw new EncounterScrubError(409, "SHADOW_REQUIRES_CLAIM", "Scrub the encounter first to create a claim for shadow comparison");
    const { row: ruleSet, pack } = await currentRulePack(tx, "SHADOW");
    const saved = claim.snapshotJson;
    let ctx: RuleContext;
    let lines: ClaimDraft["lines"];
    try {
      const sourceEncounter = EncounterSchema.parse(saved.encounter);
      if (sourceEncounter.id !== encounter.id || sourceEncounter.organizationId !== organizationId) throw new Error("Claim source mismatch");
      const minuteLines = EncounterMinuteLineSchema.array().parse(saved.minuteLines);
      const draft = saved.evaluatedDraft;
      const applied = saved.draftClaim;
      if (!draft || typeof draft !== "object" || Array.isArray(draft) || draft.encounterId !== encounterId || !Array.isArray(draft.lines)
        || !applied || typeof applied !== "object" || Array.isArray(applied) || applied.encounterId !== encounterId || !Array.isArray(applied.lines)) {
        throw new Error("Saved claim draft is unavailable");
      }
      const draftClaim: ClaimDraft = { encounterId, lines: draft.lines.map((line) => savedDraftLine.parse(line)) };
      lines = applied.lines.map((line) => savedDraftLine.parse(line));
      if (draftClaim.lines.length !== minuteLines.length || lines.length !== minuteLines.length) throw new Error("Saved line mapping is invalid");
      const coverage = CoverageSchema.parse(saved.coverage);
      const payer = PayerSchema.parse(saved.payer);
      ctx = { encounter: sourceEncounter, minuteLines, allocatedUnits: allocateUnits(minuteLines, loadMedicareMinuteLadder()), draftClaim,
        claimChargeCents: MoneyCentsSchema.parse(draftClaim.lines.reduce((sum, line) => sum + fixtureLineChargeCents(line.cptCode, line.units), 0)),
        coverage, payer, authorizations: AuthorizationSchema.array().parse(saved.authorizations),
        planOfCare: PlanOfCareSchema.nullable().parse(saved.planOfCare),
        yearToDateBilledCents: MoneyCentsSchema.parse(saved.yearToDateBilledCents), mode: "shadow" };
    } catch {
      throw new EncounterScrubError(409, "SHADOW_SOURCE_INVALID", "Saved scrub input is unavailable for shadow comparison");
    }
    const run = await runRulesWithRepository(pack.rules, ctx, { claimId: claim.id, repository: createRuleFireRepository(tx, ruleSet.id) });
    return { encounterId, claimId: claim.id, version: claim.version, status: claim.status, totalChargeCents: claim.totalChargeCents,
      totalUnits: lines.reduce((sum, line) => sum + line.units, 0), lines, rulePack: { id: pack.id, version: pack.version, mode: "shadow" as const }, ...run };
  });
}
