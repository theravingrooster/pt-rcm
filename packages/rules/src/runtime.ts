import { MoneyCentsSchema } from "@pt-rcm/domain";
import { RuleResultSchema, type BlockFinding, type DowngradeFinding, type Rule, type RuleContext, type RuleFinding, type RuleRun } from "./types.js";

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

/** Pure evaluation: no persistence, clocks, IDs, patch application, or submission. */
export function runRules(rules: readonly Rule[], ctx: RuleContext): RuleRun {
  if (ctx.mode !== "active" && ctx.mode !== "shadow") throw new TypeError("Invalid rule mode");
  MoneyCentsSchema.parse(ctx.yearToDateBilledCents);
  MoneyCentsSchema.parse(ctx.claimChargeCents);
  if (ctx.draftClaim.encounterId !== ctx.encounter.id) throw new TypeError("Draft belongs to a different encounter");
  // Never freeze the caller's objects. A misbehaving rule must not change the
  // inputs seen by later rules or mutate the caller's encounter through ctx.
  const context = freezeDeep(structuredClone(ctx));
  const ordered = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.version - b.version);
  const findings: RuleFinding[] = ordered.map((rule) => {
    let result;
    try {
      if (!rule.id.trim() || !Number.isSafeInteger(rule.version) || rule.version < 1 || !rule.description.trim()) {
        throw new TypeError("Invalid rule metadata");
      }
      result = RuleResultSchema.parse(rule.evaluate(context));
      if (result.outcome === "DOWNGRADE") {
        for (const patch of result.linePatches) {
          const line = context.allocatedUnits.lines[patch.lineIndex];
          const draftLine = context.draftClaim.lines[patch.lineIndex];
          if (!line || !draftLine || (patch.units !== undefined && patch.units > Math.min(line.units, draftLine.units))) {
            throw new RangeError("A downgrade must target an existing line and cannot increase units");
          }
        }
      }
    } catch {
      // Include rule identity, without leaking exception payloads into persisted details.
      result = { outcome: "BLOCK" as const, code: "RULE_CRASH", message: `Rule ${rule.id} failed evaluation or returned an invalid result.` };
    }
    return {
      ...result, ruleId: rule.id, ruleVersion: rule.version, description: rule.description,
      encounterId: context.encounter.id, shadow: context.mode === "shadow",
    };
  });
  const blocks = findings.filter((finding): finding is BlockFinding => finding.outcome === "BLOCK" && !finding.shadow);
  const downgrades = findings.filter((finding): finding is DowngradeFinding => finding.outcome === "DOWNGRADE" && !finding.shadow);
  return { findings, blocks, downgrades, submissionAllowed: blocks.length === 0 };
}
