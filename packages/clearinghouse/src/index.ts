import { createHash } from "node:crypto";
import { ClaimDocumentLineSchema, ClaimDocumentSchema, IdSchema, IsoDateSchema, MoneyCentsSchema, NonNegativeIntSchema, UtcTimestampSchema, type ClaimDocument, type RemitEnvelope } from "@pt-rcm/domain";

export * from "./x12/map837p.js";
export type { RemitEnvelope } from "@pt-rcm/domain";

export type EligibilityRequest = { memberId: string };
export type EligibilityResult = {
  eligible: boolean;
  coverageStatus: "active" | "inactive";
  memberId: string;
};
export type SubmitAck = {
  icn: string;
  /** Receipt for processing, not payer adjudication or payment. */
  status: "accepted-for-processing";
};
export interface ClearinghousePort {
  checkEligibility(request: EligibilityRequest): Promise<EligibilityResult>;
  submitClaim(document: ClaimDocument): Promise<SubmitAck>;
  fetchRemits(since: string): Promise<RemitEnvelope[]>;
}
export type ClearinghouseCall =
  | { method: "checkEligibility"; request: EligibilityRequest }
  | { method: "submitClaim"; document: ClaimDocument }
  | { method: "fetchRemits"; since: string };
export type FixtureRemitScript = {
  claimId: string; claimVersion?: number; totalChargeCents: number; receivedOn: string;
  lines?: Pick<ClaimDocument["lines"][number], "cptCode" | "units" | "chargeCents">[];
};

export class FixtureClearinghouse implements ClearinghousePort {
  readonly calls: ClearinghouseCall[] = [];
  private readonly remitScripts: FixtureRemitScript[];

  constructor(remitScript?: FixtureRemitScript | FixtureRemitScript[]) {
    this.remitScripts = (Array.isArray(remitScript) ? remitScript : remitScript ? [remitScript] : []).map((script) => {
      const lines = script.lines?.map((line) => ClaimDocumentLineSchema.pick({ cptCode: true, units: true, chargeCents: true }).parse(line));
      if (lines && lines.reduce((sum, line) => sum + line.chargeCents, 0) !== script.totalChargeCents) throw new Error("Fixture line charges must equal the claim charge");
      return { claimId: IdSchema.parse(script.claimId), claimVersion: NonNegativeIntSchema.min(1).parse(script.claimVersion ?? 1),
        totalChargeCents: MoneyCentsSchema.parse(script.totalChargeCents), receivedOn: IsoDateSchema.parse(script.receivedOn), lines };
    });
  }

  async checkEligibility(request: EligibilityRequest): Promise<EligibilityResult> {
    this.calls.push({ method: "checkEligibility", request: structuredClone(request) });
    const eligible = request.memberId.startsWith("SYN");
    return { eligible, coverageStatus: eligible ? "active" : "inactive", memberId: request.memberId };
  }

  async submitClaim(document: ClaimDocument): Promise<SubmitAck> {
    this.calls.push({ method: "submitClaim", document: structuredClone(document) });
    const parsed = ClaimDocumentSchema.parse(document);
    return { icn: `SYN-ICN-${parsed.claimId}`, status: "accepted-for-processing" };
  }

  async fetchRemits(since: string): Promise<RemitEnvelope[]> {
    this.calls.push({ method: "fetchRemits", since });
    const start = IsoDateSchema.or(UtcTimestampSchema).parse(since);
    return this.remitScripts.filter((script) => Date.parse(`${script.receivedOn}T00:00:00.000Z`) >= Date.parse(start)).map((script) => {
      // Round the payer's 80% to the nearest cent using integer arithmetic, then
      // assign the remaining cents to coinsurance so the two portions always sum.
      const paidCents = Math.floor((script.totalChargeCents * 80 + 50) / 100);
      const patientResponsibilityCents = script.totalChargeCents - paidCents;
      // Stable identity across polls/process restarts, distinct after a denial revision.
      const hash = createHash("sha256").update(`SYN-REMIT:${script.claimId}:${script.claimVersion}`).digest("hex");
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      let cumulativeCharge = 0;
      let cumulativePaid = 0;
      const lines = (script.lines ?? []).map((line) => {
        cumulativeCharge += line.chargeCents;
        const nextPaid = Math.floor((cumulativeCharge * 80 + 50) / 100);
        const paid = nextPaid - cumulativePaid;
        cumulativePaid = nextPaid;
        const responsibility = line.chargeCents - paid;
        return { cptCode: line.cptCode, units: line.units, paidCents: paid, patientResponsibilityCents: responsibility,
          adjustments: [{ carc: "PR-2", amountCents: responsibility }], rarc: null };
      });
      return {
        id, lines,
        claimId: script.claimId, payerIcn: `SYN-ICN-${script.claimId}`, paidCents, patientResponsibilityCents,
        carc: "PR-2", adjustments: [{ carc: "PR-2", amountCents: patientResponsibilityCents }], receivedOn: script.receivedOn,
      };
    });
  }
}

export class ClearinghouseDisabled extends Error {
  readonly code = "CLEARINGHOUSE_DISABLED";
  constructor(message = "live adapter is not enabled in this prototype") {
    super(message);
    this.name = "ClearinghouseDisabled";
  }
}

export class StediClearinghouse implements ClearinghousePort {
  /** Caller supplies STEDI_API_KEY. Never retain, log, or use it for a request. */
  constructor(apiKey: string) {
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("STEDI_API_KEY is required");
  }

  async checkEligibility(_request: EligibilityRequest): Promise<EligibilityResult> {
    throw new ClearinghouseDisabled("live adapter is not enabled in this prototype");
  }
  async submitClaim(_document: ClaimDocument): Promise<SubmitAck> {
    throw new ClearinghouseDisabled("live adapter is not enabled in this prototype");
  }
  async fetchRemits(_since: string): Promise<RemitEnvelope[]> {
    throw new ClearinghouseDisabled("live adapter is not enabled in this prototype");
  }
}
