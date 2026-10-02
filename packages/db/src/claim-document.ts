import { and, eq } from "drizzle-orm";
import {
  buildClaimDocument, ClaimDocumentInputSchema, ClaimNotSubmittable, EncounterSchema, IdSchema,
} from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";

export class ClaimDocumentReadError extends Error {
  constructor(readonly status: 404 | 422, readonly code: string, message: string) {
    super(message);
    this.name = "ClaimDocumentReadError";
  }
}

/** Read a coherent saved claim without changing its status or running any rules. */
export async function getClaimDocument(db: Database, organizationId: string, claimId: string) {
  IdSchema.parse(organizationId);
  IdSchema.parse(claimId);
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ claim: s.claims }).from(s.claims)
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.claims.id, claimId), eq(s.encounters.organizationId, organizationId)));
    if (!row) throw new ClaimDocumentReadError(404, "CLAIM_NOT_FOUND", "Claim not found in this organization");
    const { claim } = row;
    if (claim.status !== "SCRUBBED") throw new ClaimNotSubmittable(claim.status);
    const invalid = () => new ClaimDocumentReadError(422, "INVALID_CLAIM_DOCUMENT", "Saved claim sources are incomplete or inconsistent");
    const savedEncounter = EncounterSchema.safeParse(claim.snapshotJson.encounter);
    if (!savedEncounter.success || savedEncounter.data.id !== claim.encounterId || savedEncounter.data.organizationId !== organizationId) throw invalid();
    const encounter = savedEncounter.data;
    const [organization] = await tx.select().from(s.organizations).where(eq(s.organizations.id, organizationId));
    const [renderingProvider] = await tx.select().from(s.providers).where(and(eq(s.providers.id, encounter.renderingProviderId), eq(s.providers.organizationId, organizationId)));
    const [serviceFacility] = await tx.select().from(s.serviceFacilities).where(and(eq(s.serviceFacilities.id, encounter.facilityId), eq(s.serviceFacilities.organizationId, organizationId)));
    const [patient] = await tx.select().from(s.patients).where(and(eq(s.patients.id, encounter.patientId), eq(s.patients.organizationId, organizationId)));
    const storedLines = await tx.select().from(s.claimLines).where(eq(s.claimLines.claimId, claimId));
    const ids = claim.snapshotJson.claimLineIds;
    if (!Array.isArray(ids) || ids.some((id) => id !== null && typeof id !== "string")) throw invalid();
    const billedIds = ids.filter((id): id is string => typeof id === "string");
    if (billedIds.length !== storedLines.length || new Set(billedIds).size !== storedLines.length) throw invalid();
    const claimLines = billedIds.map((id) => storedLines.find((line) => line.id === id));
    const draft = claim.snapshotJson.draftClaim;
    if (!draft || typeof draft !== "object" || Array.isArray(draft) || draft.encounterId !== encounter.id
      || !Array.isArray(draft.lines) || draft.lines.length !== ids.length) throw invalid();
    // Require the reviewed clinical values and modifiers. Edits after a scrub
    // need another scrub; a GET must not silently bless changed units or codes.
    for (const [index, id] of ids.entries()) {
      const reviewed = draft.lines[index];
      if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) throw invalid();
      if (id === null) {
        if (reviewed.units !== 0) throw invalid();
        continue;
      }
      const saved = storedLines.find((line) => line.id === id);
      if (!saved || (["cptCode", "minutes", "units", "modifiers", "diagnosisPointers"] as const)
        .some((key) => JSON.stringify(saved[key]) !== JSON.stringify(reviewed[key]))) throw invalid();
    }
    // Historical service date, diagnoses, coverage and payer belong to this claim
    // version's scrub snapshot, even when ingestion has since edited the encounter.
    // Organization/provider/facility/patient demographics are current master data.
    const source = ClaimDocumentInputSchema.safeParse({
      claim, claimLines, organization, renderingProvider, serviceFacility, patient, encounter,
      coverage: claim.snapshotJson.coverage, payer: claim.snapshotJson.payer, diagnoses: claim.snapshotJson.diagnoses,
    });
    if (!source.success) throw invalid();
    try {
      return buildClaimDocument(source.data);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") throw invalid();
      throw error;
    }
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
