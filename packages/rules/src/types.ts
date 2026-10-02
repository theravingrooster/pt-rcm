import { z } from "zod";
import {
  NonNegativeIntSchema,
  type Authorization, type ClaimLine, type Coverage, type Encounter,
  type EncounterMinuteLine, type Payer, type PlanOfCare, type UnitAllocation,
} from "@pt-rcm/domain";

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type RuleContext = DeepReadonly<{
  encounter: Encounter;
  minuteLines: EncounterMinuteLine[];
  allocatedUnits: UnitAllocation;
  coverage: Coverage | null;
  payer: Payer;
  authorizations: Authorization[];
  planOfCare: PlanOfCare | null;
  /** Supplied by the caller for this patient+payer and service year; integer cents. */
  yearToDateBilledCents: number;
  mode: "active" | "shadow";
}>;

// Indexes refer to the stable allocation/draft line order, including zero-unit lines.
// Strict validation forbids adding minutes, codes, diagnoses, or other services.
export const LinePatchSchema = z.object({
  lineIndex: NonNegativeIntSchema,
  units: NonNegativeIntSchema,
}).strict();
export type LinePatch = z.infer<typeof LinePatchSchema>;

const explanation = { code: z.string().trim().min(1), message: z.string().trim().min(1) };
export const RuleResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("PASS") }).strict(),
  z.object({ outcome: z.literal("FLAG"), ...explanation }).strict(),
  z.object({ outcome: z.literal("DOWNGRADE"), ...explanation, linePatches: z.array(LinePatchSchema).min(1) }).strict(),
  z.object({ outcome: z.literal("BLOCK"), ...explanation }).strict(),
]);
export type RuleResult = z.infer<typeof RuleResultSchema>;

export type Rule = Readonly<{
  id: string;
  version: number;
  description: string;
  evaluate(ctx: RuleContext): RuleResult;
}>;

export type RuleFinding = RuleResult & {
  ruleId: string;
  ruleVersion: number;
  description: string;
  encounterId: string;
  shadow: boolean;
};
export type BlockFinding = Extract<RuleFinding, { outcome: "BLOCK" }>;
export type DowngradeFinding = Extract<RuleFinding, { outcome: "DOWNGRADE" }>;
export type RuleRun = {
  /** One finding per evaluated rule, including PASS and hypothetical shadow outcomes. */
  findings: RuleFinding[];
  /** Active blocks only. Shadow blocks remain visible in findings. */
  blocks: BlockFinding[];
  /** Active proposals only; nothing is applied during evaluation. */
  downgrades: DowngradeFinding[];
  submissionAllowed: boolean;
};

/** Unpriced draft before claim persistence. Keep the same line order as allocatedUnits. */
export type ClaimDraftLine = Pick<ClaimLine, "cptCode" | "units" | "minutes" | "modifiers" | "diagnosisPointers">;
export type ClaimDraft = DeepReadonly<{
  encounterId: string;
  lines: ClaimDraftLine[];
}>;
