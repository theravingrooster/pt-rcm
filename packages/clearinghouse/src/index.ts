import { ClaimDocumentSchema, IsoDateSchema, UtcTimestampSchema, type ClaimDocument, type RemitEnvelope } from "@pt-rcm/domain";
import { parseSynthetic835, renderFixture835 } from "./x12/parse835.js";

export * from "./x12/map837p.js";
export { parseSynthetic835, renderFixture835 } from "./x12/parse835.js";
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
  outcome?: "COINSURANCE" | "PAID" | "DENIED";
};

export class FixtureClearinghouse implements ClearinghousePort {
  readonly calls: ClearinghouseCall[] = [];
  private readonly remitTexts: string[];

  constructor(remitScript?: FixtureRemitScript | string | (FixtureRemitScript | string)[]) {
    // Submitted claim metadata is rendered to 835-shaped text immediately.
    // Raw text fixtures take the same parser path; JSON never enters posting.
    this.remitTexts = (Array.isArray(remitScript) ? remitScript : remitScript ? [remitScript] : [])
      .map((script) => typeof script === "string" ? script : renderFixture835(script));
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
    return this.remitTexts.map(parseSynthetic835)
      .filter((remit) => Date.parse(`${remit.receivedOn}T00:00:00.000Z`) >= Date.parse(start));
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
