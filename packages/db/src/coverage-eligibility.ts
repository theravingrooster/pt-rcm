import { and, eq } from "drizzle-orm";
import type { ClearinghousePort, EligibilityResult } from "@pt-rcm/clearinghouse";
import { IdSchema } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";

export class CoverageEligibilityError extends Error {
  constructor(readonly status: 404 | 502 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "CoverageEligibilityError";
  }
}

export type FixtureEligibilityOptions = {
  adapter: string | undefined;
  clearinghouse: Pick<ClearinghousePort, "checkEligibility">;
};

/** Only the synthetic fixture can be selected. The cache belongs to a coverage
 * scoped through its patient, so a caller cannot probe another organization.
 */
export async function checkCoverageEligibility(
  db: Database, organizationId: string, coverageId: string, options: FixtureEligibilityOptions,
) {
  if (options.adapter !== "fixture") {
    throw new CoverageEligibilityError(503, "CLEARINGHOUSE_ADAPTER_DISABLED", "CLEARINGHOUSE_ADAPTER must be fixture");
  }
  IdSchema.parse(organizationId);
  IdSchema.parse(coverageId);
  return db.transaction(async (tx) => {
    const [record] = await tx.select({ coverage: s.coverages }).from(s.coverages)
      .innerJoin(s.patients, eq(s.patients.id, s.coverages.patientId))
      .where(and(eq(s.coverages.id, coverageId), eq(s.patients.organizationId, organizationId)))
      .for("update", { of: s.coverages });
    if (!record) throw new CoverageEligibilityError(404, "COVERAGE_NOT_FOUND", "Coverage not found in this organization");

    const result: EligibilityResult = await options.clearinghouse.checkEligibility({ memberId: record.coverage.memberId });
    if (result?.memberId !== record.coverage.memberId || typeof result.eligible !== "boolean" ||
      (result.coverageStatus !== "active" && result.coverageStatus !== "inactive")) {
      throw new CoverageEligibilityError(502, "INVALID_ELIGIBILITY_RESULT", "Fixture returned an invalid eligibility result");
    }
    const checkedAt = new Date().toISOString();
    const [saved] = await tx.update(s.coverages).set({
      eligible: result.eligible,
      checkedAt,
      deductibleRemainingCents: null,
      planActive: result.coverageStatus === "active",
    }).where(eq(s.coverages.id, coverageId)).returning();
    if (!saved) throw new CoverageEligibilityError(404, "COVERAGE_NOT_FOUND", "Coverage not found in this organization");
    return { coverageId, eligible: saved.eligible, checkedAt: saved.checkedAt,
      deductibleRemainingCents: saved.deductibleRemainingCents, planActive: saved.planActive, adapter: "fixture" as const };
  });
}
