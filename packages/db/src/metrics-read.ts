import { and, desc, eq, inArray } from "drizzle-orm";
import { computeMetrics, IdSchema, MetricMinuteLinesSchema, PayerTypeSchema, UnitRuleSchema, type MetricClaim } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";

/** Read the latest claim per encounter. Receipts from earlier denial revisions
 * and unmatched receipts do not enter the current payer collection numerator.
 */
export async function readOperatorMetrics(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  return db.transaction(async (tx) => {
    const claims = await tx.selectDistinctOn([s.claims.encounterId], { claim: s.claims })
      .from(s.claims).innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(eq(s.encounters.organizationId, organizationId))
      .orderBy(s.claims.encounterId, desc(s.claims.version));
    if (!claims.length) return computeMetrics([]);
    const ids = claims.map(({ claim }) => claim.id);
    const [lines, tasks, submittedAudits, remits] = await Promise.all([
      tx.select().from(s.claimLines).where(inArray(s.claimLines.claimId, ids)),
      tx.select({ claimId: s.tasks.claimId }).from(s.tasks).where(and(
        inArray(s.tasks.claimId, ids), eq(s.tasks.owner, "OPERATOR"))),
      tx.select({ entityId: s.auditEvents.entityId }).from(s.auditEvents).where(and(
        inArray(s.auditEvents.entityId, ids), eq(s.auditEvents.entity, "Claim"), eq(s.auditEvents.action, "CLAIM_SUBMITTED"))),
      tx.select().from(s.remits).where(inArray(s.remits.claimId, ids)),
    ]);
    const versions = new Map(claims.map(({ claim }) => [claim.id, claim.version]));
    const matched = remits.filter((remit) => {
      const result = remit.detailJson.result;
      return typeof result === "object" && result !== null && !Array.isArray(result) && result.matched === true
        && remit.detailJson.claimVersion === versions.get(remit.claimId);
    });
    const remitLines = matched.length ? await tx.select().from(s.remitLines)
      .where(inArray(s.remitLines.remitId, matched.map((remit) => remit.id))) : [];
    const taskIds = new Set(tasks.map((task) => task.claimId));
    const submittedIds = new Set(submittedAudits.map((audit) => audit.entityId));
    const input: MetricClaim[] = claims.map(({ claim }) => {
      const source = MetricMinuteLinesSchema.safeParse(claim.snapshotJson.minuteLines);
      const savedPayer = claim.snapshotJson.payer;
      const policy = savedPayer && typeof savedPayer === "object" && !Array.isArray(savedPayer) ? savedPayer : null;
      const payerType = PayerTypeSchema.safeParse(policy?.payerType);
      const unitRule = UnitRuleSchema.safeParse(policy?.unitRule);
      return {
        status: claim.status,
        // A saved scrub carries its own payer policy. Older snapshots without
        // this policy used Medicare daily pooling, even for commercial payers.
        payerType: payerType.success ? payerType.data : "MEDICARE",
        unitRule: unitRule.success ? unitRule.data : "MEDICARE_8_MINUTE",
        everSubmitted: submittedIds.has(claim.id),
        operatorTaskEverOpened: taskIds.has(claim.id), totalChargeCents: claim.totalChargeCents,
        minuteLines: source.success ? source.data : null,
        billedLines: lines.filter((line) => line.claimId === claim.id).map(({ cptCode, units }) => ({ cptCode, units })),
        remits: matched.filter((remit) => remit.claimId === claim.id).map((remit) => ({
          paidCents: remit.paidCents, patientResponsibilityCents: remit.patientResponsibilityCents,
          contractualWriteOffCents: remitLines.filter((line) => line.remitId === remit.id)
            .reduce((sum, line) => sum + line.contractualWriteOffCents, 0),
        })),
      };
    });
    return computeMetrics(input);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
