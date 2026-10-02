import { IdSchema, type RuleFire } from "@pt-rcm/domain";
import { runRules } from "./runtime.js";
import type { Rule, RuleContext, RuleRun } from "./types.js";

/** The repository supplies database-generated IDs and UTC creation timestamps. */
export type RuleFireInsert = Omit<RuleFire, "id" | "createdAt">;
export interface RuleFireRepository {
  /** Insert this run's complete batch atomically, or reject. */
  insertRuleFires(rows: readonly RuleFireInsert[]): Promise<void>;
}

/** Pure conversion; RuleFire's existing persistence schema stores versions as text. */
export function toRuleFireRows(claimId: string, run: RuleRun): RuleFireInsert[] {
  IdSchema.parse(claimId);
  return run.findings.map((finding) => ({
    claimId, ruleId: finding.ruleId, ruleVersion: String(finding.ruleVersion),
    outcome: finding.outcome, shadow: finding.shadow,
    detailJson: {
      ...(finding.outcome === "PASS" ? {} : structuredClone(finding.detail ?? {})),
      encounterId: finding.encounterId, description: finding.description,
      ...(finding.outcome === "PASS" ? {} : { code: finding.code, message: finding.message }),
      ...(finding.outcome === "DOWNGRADE" ? { linePatches: structuredClone(finding.linePatches) } : {}),
    },
  }));
}

/** Optional I/O boundary. runRules itself always remains synchronous and pure. */
export async function runRulesWithRepository(
  rules: readonly Rule[],
  ctx: RuleContext,
  persistence?: { claimId: string; repository: RuleFireRepository },
): Promise<RuleRun> {
  if (persistence) IdSchema.parse(persistence.claimId);
  const run = runRules(rules, ctx);
  if (persistence && run.findings.length) {
    // A failed audit write rejects the call; it cannot silently return permission to submit.
    await persistence.repository.insertRuleFires(toRuleFireRows(persistence.claimId, run));
  }
  return run;
}
