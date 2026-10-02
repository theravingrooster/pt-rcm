import { and, eq } from "drizzle-orm";
import { IdSchema } from "@pt-rcm/domain";
import { resolveRulePack } from "@pt-rcm/rules";
import type { Database } from "./index.js";
import * as s from "./schema.js";

type PackRow = typeof s.ruleSets.$inferSelect;

export class RulePackError extends Error {
  constructor(readonly status: 404 | 409, readonly code: string, message: string) {
    super(message);
    this.name = "RulePackError";
  }
}

function executablePack(row: PackRow) {
  try {
    const pack = resolveRulePack(row.definitionJson);
    if (String(pack.version) !== row.version) throw new Error("Rule pack version does not match the saved manifest");
    return { row, pack };
  } catch {
    throw new RulePackError(409, "RULE_PACK_UNAVAILABLE", `Rule pack ${row.version} does not match deployed rules`);
  }
}

/** The database status selects the executable roster; a retired pack is never run. */
export async function currentRulePack(db: Pick<Database, "select">, status: "ACTIVE" | "SHADOW") {
  const rows = await db.select().from(s.ruleSets).where(eq(s.ruleSets.status, status)).for("share");
  if (!rows.length) throw new RulePackError(409, "RULE_PACK_MISSING", `No ${status.toLowerCase()} pack. Run pnpm db:seed.`);
  if (status === "ACTIVE" && rows.length !== 1) throw new RulePackError(409, "RULE_PACK_AMBIGUOUS", "Expected one active pack");
  // Multiple candidates may be staged; the highest numeric version is current.
  const row = status === "ACTIVE" ? rows[0]! : rows.filter((candidate) => /^\d+$/.test(candidate.version))
    .sort((a, b) => Number(b.version) - Number(a.version))[0];
  if (!row) throw new RulePackError(409, "RULE_PACK_MISSING", "No deployed shadow pack. Run pnpm db:seed.");
  return executablePack(row);
}

/** A shadow run must be tied to a saved claim before this transition is allowed. */
export async function promoteRulePack(db: Database, version: string) {
  return db.transaction((tx) => promoteRulePackInTransaction(tx, version));
}

/** Exposed so transactional integration tests can roll the promotion back. */
export async function promoteRulePackInTransaction(tx: Pick<Database, "select" | "update">, version: string) {
  if (!/^\d+$/.test(version)) throw new RulePackError(404, "RULE_PACK_NOT_FOUND", "Rule pack version not found");
  // Lock in a stable order, then retire and activate atomically. A partial
  // unique index also prevents two active packs if callers race.
  const packs = await tx.select().from(s.ruleSets).orderBy(s.ruleSets.version).for("update");
  const target = packs.find((pack) => pack.version === version);
  if (!target) throw new RulePackError(404, "RULE_PACK_NOT_FOUND", "Rule pack version not found");
  if (target.status !== "SHADOW") throw new RulePackError(409, "RULE_PACK_NOT_SHADOW", "Only a shadow pack can be promoted");
  executablePack(target);
  const active = packs.filter((pack) => pack.status === "ACTIVE");
  if (active.length !== 1) throw new RulePackError(409, "RULE_PACK_AMBIGUOUS", "Expected one active pack");
  const evidence = await tx.select({ claimId: s.ruleFires.claimId }).from(s.ruleFires).where(and(
    eq(s.ruleFires.ruleSetId, target.id), eq(s.ruleFires.shadow, true),
  )).limit(1);
  if (!evidence.length) throw new RulePackError(409, "SHADOW_EVIDENCE_REQUIRED", "Run this shadow pack on at least one claim before promotion");
  await tx.update(s.ruleSets).set({ status: "RETIRED" }).where(eq(s.ruleSets.id, active[0]!.id));
  const [promoted] = await tx.update(s.ruleSets).set({ status: "ACTIVE" }).where(eq(s.ruleSets.id, target.id)).returning();
  return { version: promoted!.version, status: promoted!.status, retiredVersion: active[0]!.version,
    testedClaimId: IdSchema.parse(evidence[0]!.claimId) };
}
