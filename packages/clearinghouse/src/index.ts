import { ClaimDocumentSchema, IdSchema, IsoDateSchema, MoneyCentsSchema, UtcTimestampSchema, type ClaimDocument } from "@pt-rcm/domain";

export * from "./x12/map837p.js";

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
export type RemitEnvelope = {
  claimId: string;
  payerIcn: string;
  paidCents: number;
  patientResponsibilityCents: number;
  carc: string;
  adjustments: { carc: string; amountCents: number }[];
  receivedOn: string;
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
export type FixtureRemitScript = { claimId: string; totalChargeCents: number; receivedOn: string };

export class FixtureClearinghouse implements ClearinghousePort {
  readonly calls: ClearinghouseCall[] = [];
  private readonly remitScript: FixtureRemitScript | undefined;

  constructor(remitScript?: FixtureRemitScript) {
    if (remitScript) this.remitScript = {
      claimId: IdSchema.parse(remitScript.claimId),
      totalChargeCents: MoneyCentsSchema.parse(remitScript.totalChargeCents),
      receivedOn: IsoDateSchema.parse(remitScript.receivedOn),
    };
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
    const script = this.remitScript;
    if (!script || Date.parse(`${script.receivedOn}T00:00:00.000Z`) < Date.parse(start)) return [];
    // Round the payer's 80% to the nearest cent using integer arithmetic, then
    // assign the remaining cents to coinsurance so the two portions always sum.
    const paidCents = Math.floor((script.totalChargeCents * 80 + 50) / 100);
    const patientResponsibilityCents = script.totalChargeCents - paidCents;
    return [{
      claimId: script.claimId, payerIcn: `SYN-ICN-${script.claimId}`, paidCents, patientResponsibilityCents,
      carc: "PR-2", adjustments: [{ carc: "PR-2", amountCents: patientResponsibilityCents }], receivedOn: script.receivedOn,
    }];
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
