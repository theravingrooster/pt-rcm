import type { RuleFire } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import { ruleFires } from "./schema.js";

/** Structurally implements the rules repository port; also accepts a transaction. */
export function createRuleFireRepository(db: Pick<Database, "insert">, ruleSetId?: string) {
  return {
    async insertRuleFires(rows: readonly Omit<RuleFire, "id" | "createdAt">[]): Promise<void> {
      if (rows.length) await db.insert(ruleFires).values(rows.map((row) => ({ ...row, ruleSetId: ruleSetId ?? row.ruleSetId ?? null })));
    },
  };
}
