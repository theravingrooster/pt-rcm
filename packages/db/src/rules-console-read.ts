import { and, desc, eq, inArray } from "drizzle-orm";
import { IdSchema } from "@pt-rcm/domain";
import { resolveRulePack } from "@pt-rcm/rules";
import type { Database } from "./index.js";
import * as s from "./schema.js";

const readOnly = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/** The inventory follows the deployed manifests; an archived pack is never presented as executable. */
export async function readRulesConsole(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(s.ruleSets)
      .where(inArray(s.ruleSets.status, ["ACTIVE", "SHADOW"]));
    const active = rows.find((row) => row.status === "ACTIVE");
    const shadow = rows.filter((row) => row.status === "SHADOW" && /^\d+$/.test(row.version))
      .sort((a, b) => Number(b.version) - Number(a.version))[0];
    const catalog = new Map<string, {
      id: string; version: number; description: string; active: boolean; shadow: boolean;
    }>();
    for (const row of [active, shadow]) {
      if (!row) continue;
      const pack = resolveRulePack(row.definitionJson);
      if (String(pack.version) !== row.version) throw new Error(`Rule pack ${row.version} does not match deployed rules`);
      for (const rule of pack.rules) {
        const prior = catalog.get(rule.id);
        catalog.set(rule.id, { id: rule.id, version: rule.version,
          description: rule.description, active: row.status === "ACTIVE" || Boolean(prior?.active),
          shadow: row.status === "SHADOW" || Boolean(prior?.shadow) });
      }
    }
    return { activeVersion: active?.version ?? null, shadowVersion: shadow?.version ?? null,
      rules: [...catalog.values()] };
  }, readOnly);
}

/** Recent audit rows are limited to this synthetic org, with both active and shadow runs. */
export async function readRuleHistory(db: Database, organizationId: string, ruleId: string) {
  IdSchema.parse(organizationId);
  const inventory = await readRulesConsole(db, organizationId);
  const rule = inventory.rules.find((entry) => entry.id === ruleId);
  if (!rule) return null;
  const fires = await db.select({ fire: s.ruleFires, claim: s.claims, encounter: s.encounters,
    patient: s.patients, pack: s.ruleSets })
    .from(s.ruleFires)
    .innerJoin(s.claims, eq(s.claims.id, s.ruleFires.claimId))
    .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
    .innerJoin(s.patients, eq(s.patients.id, s.encounters.patientId))
    .leftJoin(s.ruleSets, eq(s.ruleSets.id, s.ruleFires.ruleSetId))
    .where(and(eq(s.ruleFires.ruleId, ruleId), eq(s.encounters.organizationId, organizationId)))
    .orderBy(desc(s.ruleFires.createdAt), desc(s.ruleFires.id)).limit(25);
  return { rule, fires, activeVersion: inventory.activeVersion, shadowVersion: inventory.shadowVersion };
}
