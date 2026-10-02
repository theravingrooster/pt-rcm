import { z } from "zod";
import { ClaimLineSchema, ClaimSchema, ClaimStatusSchema, CptCodeSchema, IdSchema, IsoDateSchema, MoneyCentsSchema,
  NonNegativeIntSchema, type ClaimStatus } from "./models.js";
import { transitionClaim } from "./lifecycle.js";

export const RemitAdjustmentSchema = z.object({
  carc: z.string().regex(/^(?:PR|CO|OA|PI)-\d+$/), amountCents: MoneyCentsSchema,
}).strict();
export const RemitServiceLineSchema = z.object({
  cptCode: CptCodeSchema, units: NonNegativeIntSchema.min(1), paidCents: MoneyCentsSchema,
  // Optional summary of the PR adjustments, not an additional amount to add to them.
  patientResponsibilityCents: MoneyCentsSchema.optional(),
  adjustments: z.array(RemitAdjustmentSchema), rarc: z.string().min(1).nullable().default(null),
}).strict();
export const RemitEnvelopeSchema = z.object({
  id: IdSchema, claimId: IdSchema, payerIcn: z.string().min(1), receivedOn: IsoDateSchema,
  paidCents: MoneyCentsSchema, patientResponsibilityCents: MoneyCentsSchema,
  carc: z.string().min(1).optional(), adjustments: z.array(RemitAdjustmentSchema),
  lines: z.array(RemitServiceLineSchema),
}).strict();
export type RemitAdjustment = z.infer<typeof RemitAdjustmentSchema>;
export type RemitServiceLine = z.infer<typeof RemitServiceLineSchema>;
export type RemitEnvelope = z.infer<typeof RemitEnvelopeSchema>;
const RemittableClaimSchema = ClaimSchema.extend({ lines: z.array(ClaimLineSchema).min(1) });
export type RemittableClaim = z.infer<typeof RemittableClaimSchema>;
const RemitFlagSchema = z.object({ outcome: z.literal("FLAG"), code: z.literal("REMIT_OUT_OF_BALANCE"), message: z.string(), lineIndex: NonNegativeIntSchema.nullable() });
export type RemitFlag = z.infer<typeof RemitFlagSchema>;
export const RemitPostingResultSchema = z.object({
  remitId: IdSchema, claimId: IdSchema, status: ClaimStatusSchema, matched: z.boolean(), duplicate: z.boolean(),
  flags: z.array(RemitFlagSchema), authorizationVisitDecremented: z.boolean(),
}).strict();
export type RemitPostingResult = z.infer<typeof RemitPostingResultSchema>;
export type RemitTask = { kind: "REMIT_UNMATCHED" | "REMIT_OUT_OF_BALANCE"; reason: string };
export type AppliedRemitLine = RemitServiceLine & {
  claimLineId: string; chargeCents: number; patientResponsibilityCents: number;
  adjustmentCents: number; contractualWriteOffCents: number;
};

export class RemitNotPostable extends Error {
  readonly code = "REMIT_NOT_POSTABLE";
  constructor(message: string) { super(message); this.name = "RemitNotPostable"; }
}

/** Pure prototype posting decision. CPT + units must form a complete one-to-one
 * match; partial remits and duplicate keys require operator review, never guesses.
 * PR adjustment amounts are reclassified as patient responsibility. The supplied
 * PR summary is checked, not added again. All other adjustments stay non-patient.
 * Reported numbers are never repaired to make an out-of-balance remit balance.
 */
export function applyRemit(claim: RemittableClaim, remitEnvelope: RemitEnvelope) {
  const current = RemittableClaimSchema.parse(claim);
  const envelope = RemitEnvelopeSchema.parse(remitEnvelope);
  if (envelope.claimId !== current.id || current.lines.some((line) => line.claimId !== current.id)) {
    throw new RemitNotPostable("Remit and claim lines must belong to this claim");
  }
  if (current.status !== "SUBMITTED" && current.status !== "ACCEPTED") {
    throw new RemitNotPostable(`Cannot post a new remit to a ${current.status} claim`);
  }
  const key = (line: { cptCode: string; units: number }) => `${line.cptCode}:${line.units}`;
  const unique = (lines: { cptCode: string; units: number }[]) => new Set(lines.map(key)).size === lines.length;
  const matched = unique(current.lines) && unique(envelope.lines) && envelope.lines.length === current.lines.length
    && envelope.lines.every((line) => current.lines.some((candidate) => key(candidate) === key(line)));
  const flags: RemitFlag[] = [];
  const tasks: RemitTask[] = [];
  const transitions: ClaimStatus[] = [];
  if (!matched) {
    tasks.push({ kind: "REMIT_UNMATCHED", reason: "Remit lines do not uniquely match every claim line by CPT + units." });
    return { claim: current, matched, lines: [] as AppliedRemitLine[], transitions, flags, tasks,
      paidCents: envelope.paidCents, patientResponsibilityCents: envelope.patientResponsibilityCents,
      adjustmentCents: MoneyCentsSchema.parse(envelope.adjustments.filter((a) => !a.carc.startsWith("PR-")).reduce((sum, a) => sum + a.amountCents, 0)),
    };
  }
  const flag = (message: string, lineIndex: number | null) => flags.push({ outcome: "FLAG", code: "REMIT_OUT_OF_BALANCE", message, lineIndex });
  const lines: AppliedRemitLine[] = envelope.lines.map((line, lineIndex) => {
    const saved = current.lines.find((candidate) => key(candidate) === key(line))!;
    const pr = line.adjustments.filter((a) => a.carc.startsWith("PR-"));
    const patientResponsibilityCents = MoneyCentsSchema.parse(pr.length
      ? pr.reduce((sum, a) => sum + a.amountCents, 0) : line.patientResponsibilityCents ?? 0);
    const adjustmentCents = MoneyCentsSchema.parse(line.adjustments.filter((a) => !a.carc.startsWith("PR-")).reduce((sum, a) => sum + a.amountCents, 0));
    const contractualWriteOffCents = MoneyCentsSchema.parse(line.adjustments.filter((a) => a.carc.startsWith("CO-")).reduce((sum, a) => sum + a.amountCents, 0));
    if (line.patientResponsibilityCents !== undefined && line.patientResponsibilityCents !== patientResponsibilityCents) {
      flag("Reported patient responsibility differs from the PR-coded amounts; PR-coded amounts were posted.", lineIndex);
    }
    if (line.paidCents + adjustmentCents + patientResponsibilityCents !== saved.chargeCents) {
      flag(`Paid + adjustments + patient responsibility do not equal the ${saved.chargeCents}-cent line charge.`, lineIndex);
    }
    return { ...line, claimLineId: saved.id, chargeCents: saved.chargeCents, patientResponsibilityCents, adjustmentCents, contractualWriteOffCents };
  });
  const paidCents = MoneyCentsSchema.parse(lines.reduce((sum, line) => sum + line.paidCents, 0));
  const patientResponsibilityCents = MoneyCentsSchema.parse(lines.reduce((sum, line) => sum + line.patientResponsibilityCents, 0));
  const adjustmentCents = MoneyCentsSchema.parse(lines.reduce((sum, line) => sum + line.adjustmentCents, 0));
  if (paidCents !== envelope.paidCents || patientResponsibilityCents !== envelope.patientResponsibilityCents
    || current.lines.reduce((sum, line) => sum + line.chargeCents, 0) !== current.totalChargeCents) {
    flag("Claim or remit summary totals differ from their service lines; service-line amounts were posted.", null);
  }
  if (flags.length) tasks.push({ kind: "REMIT_OUT_OF_BALANCE", reason: flags.map((finding) => finding.message).join(" ") });
  const denialCodes = new Set(["CO-4", "CO-16", "CO-50", "CO-197"]);
  const denied = paidCents === 0 && (denialCodes.has(envelope.carc ?? "")
    || [...lines.flatMap((line) => line.adjustments), ...envelope.adjustments].some((adjustment) => denialCodes.has(adjustment.carc)));
  const target = denied ? "DENIED" : paidCents > 0 ? patientResponsibilityCents > 0 ? "PATIENT_BALANCE" : "PAID" : null;
  let next = current;
  if (target) {
    // A matched adjudication supplies acceptance evidence. Traverse both edges;
    // never introduce a SUBMITTED -> payment/denial shortcut in the state machine.
    const path: ClaimStatus[] = [...(current.status === "SUBMITTED" ? ["ACCEPTED" as const] : []), target];
    for (const status of path) {
      const { lines: claimLines, ...record } = next;
      next = { ...transitionClaim(record, status), lines: claimLines };
      transitions.push(status);
    }
  }
  return { claim: next, matched, lines, transitions, flags, tasks, paidCents, patientResponsibilityCents, adjustmentCents };
}
