import { NonNegativeIntSchema } from "@pt-rcm/domain";
import { RuleResultSchema, type ClaimDraft, type DowngradeFinding } from "./types.js";

/**
 * Apply active proposals to a new unpriced draft. Patches specify absolute unit
 * ceilings, not deltas: overlapping proposals take the lowest ceiling, independent
 * of rule order. Zero-unit lines remain for the caller to review before persistence.
 * GP may be added without duplicates. No minutes, codes, diagnoses, charges,
 * other modifiers, or source encounters are edited.
 */
export function applyDowngrades(draft: ClaimDraft, downgrades: readonly DowngradeFinding[]): ClaimDraft {
  const ceilings = draft.lines.map((line) => NonNegativeIntSchema.parse(line.units));
  const additions = draft.lines.map(() => new Set<string>());
  for (const finding of downgrades) {
    if (finding.shadow) continue;
    if (finding.encounterId !== draft.encounterId) throw new Error("Downgrade belongs to a different encounter");
    const result = RuleResultSchema.parse({
      outcome: finding.outcome, code: finding.code, message: finding.message, linePatches: finding.linePatches,
    });
    if (result.outcome !== "DOWNGRADE") throw new TypeError("Expected a downgrade finding");
    for (const patch of result.linePatches) {
      const original = draft.lines[patch.lineIndex];
      if (!original || (patch.units !== undefined && patch.units > original.units)) throw new RangeError("A downgrade must target an existing line and cannot increase units");
      if (patch.units !== undefined) ceilings[patch.lineIndex] = Math.min(ceilings[patch.lineIndex]!, patch.units);
      patch.addModifiers?.forEach((modifier) => additions[patch.lineIndex]!.add(modifier));
    }
  }
  const copy = structuredClone(draft);
  return { ...copy, lines: copy.lines.map((line, index) => ({
    ...line, units: ceilings[index]!,
    modifiers: [...line.modifiers, ...[...additions[index]!].filter((modifier) => !line.modifiers.includes(modifier))],
  })) };
}
