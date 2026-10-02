import { and, desc, eq } from "drizzle-orm";
import { ClaimNotSubmittable, IdSchema, JsonObjectSchema, transitionClaim } from "@pt-rcm/domain";
import type { ClearinghousePort } from "@pt-rcm/clearinghouse";
import type { Database } from "./index.js";
import { ClaimDocumentReadError, readClaimDocument } from "./claim-document.js";
import { encounterSourceFingerprint } from "./encounter-source.js";
import * as s from "./schema.js";

export class ClaimSubmissionError extends Error {
  constructor(readonly status: 409 | 503 | 502, readonly code: string, message: string) {
    super(message);
    this.name = "ClaimSubmissionError";
  }
}

export type FixtureSubmissionOptions = { adapter: string | undefined; clearinghouse: ClearinghousePort };

/** Fixture receipt only. A live adapter is never selected by this service. */
export async function submitScrubbedClaim(db: Database, organizationId: string, claimId: string, options: FixtureSubmissionOptions) {
  if (options.adapter !== "fixture") {
    throw new ClaimSubmissionError(503, "CLEARINGHOUSE_ADAPTER_DISABLED", "CLEARINGHOUSE_ADAPTER must be fixture");
  }
  IdSchema.parse(organizationId);
  IdSchema.parse(claimId);
  return db.transaction(async (tx) => {
    const [reference] = await tx.select({ encounterId: s.claims.encounterId }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.claims.id, claimId), eq(s.encounters.organizationId, organizationId)));
    if (!reference) throw new ClaimDocumentReadError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    // Follow ingestion/scrub's encounter -> claims lock order. Concurrent requests
    // wait here, then see SUBMITTED and cannot make a second adapter call.
    const [encounter] = await tx.select().from(s.encounters).where(and(
      eq(s.encounters.id, reference.encounterId), eq(s.encounters.organizationId, organizationId),
    )).for("update");
    if (!encounter) throw new ClaimDocumentReadError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    const siblings = await tx.select().from(s.claims).where(eq(s.claims.encounterId, encounter.id)).orderBy(desc(s.claims.version)).for("update");
    const claim = siblings.find((row) => row.id === claimId);
    if (!claim) throw new ClaimDocumentReadError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    if (claim.status !== "SCRUBBED") throw new ClaimNotSubmittable(claim.status);
    // Validate the lifecycle before any adapter side effect. Persist only on ack.
    const submitted = transitionClaim(claim, "SUBMITTED");
    if (siblings[0]!.id !== claimId) throw new ClaimSubmissionError(409, "CLAIM_SUPERSEDED", "Only the latest scrubbed version can be submitted");
    const preSubmission = new Set(["DRAFT", "SCRUBBED", "BLOCKED", "SHADOWED"]);
    if (encounter.status === "CLAIMED" || siblings.some((row) => !preSubmission.has(row.status))) {
      throw new ClaimSubmissionError(409, "CLAIM_ALREADY_SUBMITTED", "This encounter already has a submitted claim");
    }
    const coverage = await tx.select().from(s.coverages).where(and(eq(s.coverages.patientId, encounter.patientId), eq(s.coverages.active, true)));
    const minuteLines = await tx.select().from(s.encounterMinuteLines).where(eq(s.encounterMinuteLines.encounterId, encounter.id))
      .orderBy(s.encounterMinuteLines.cptCode, s.encounterMinuteLines.id);
    const diagnoses = await tx.select().from(s.diagnoses).where(eq(s.diagnoses.encounterId, encounter.id)).orderBy(s.diagnoses.pointer);
    if (coverage.length !== 1 || claim.snapshotJson.sourceFingerprint !== encounterSourceFingerprint(encounter, coverage[0]!, minuteLines, diagnoses)) {
      throw new ClaimSubmissionError(409, "CLAIM_NEEDS_SCRUB", "Encounter inputs changed; scrub the current draft before submission");
    }
    await tx.select({ id: s.claimLines.id }).from(s.claimLines).where(eq(s.claimLines.claimId, claimId)).for("update");
    const document = await readClaimDocument(tx, organizationId, claimId);
    const ack = await options.clearinghouse.submitClaim(document);
    if (ack?.status !== "accepted-for-processing" || typeof ack.icn !== "string" || !/^SYN-ICN-.+/.test(ack.icn)) {
      throw new ClaimSubmissionError(502, "INVALID_SUBMIT_ACK", "Fixture did not return an accepted-for-processing acknowledgment");
    }
    const submittedAt = new Date().toISOString();
    await tx.update(s.claims).set({ status: submitted.status, version: submitted.version, snapshotJson: JsonObjectSchema.parse({
      ...claim.snapshotJson, submission: { adapter: "fixture", acknowledgment: ack, document, submittedAt },
    }) }).where(eq(s.claims.id, claimId));
    await tx.update(s.encounters).set({ status: "CLAIMED" }).where(eq(s.encounters.id, encounter.id));
    await tx.insert(s.auditEvents).values({
      actor: "SYN-FIXTURE-SUBMIT", action: "CLAIM_SUBMITTED", entity: "Claim", entityId: claimId, at: submittedAt,
      detailJson: { adapter: "fixture", icn: ack.icn, acknowledgmentStatus: ack.status, encounterId: encounter.id },
    });
    return { claimId, encounterId: encounter.id, status: "SUBMITTED" as const, icn: ack.icn, acknowledgment: ack };
  });
}
