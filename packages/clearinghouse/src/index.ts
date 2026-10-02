export * from "./x12/map837p.js";

export type EligibilityResult = {
  eligible: boolean;
  memberId: string;
};

export type SubmitAck = {
  icn: string;
  status: "accepted";
};

export type RemitEnvelope = {
  claimId: string;
  paidCents: number;
  patientResponsibilityCents: number;
  carc: string;
};

export interface ClearinghousePort {
  checkEligibility(request: { memberId: string }): Promise<EligibilityResult>;
  submitClaim(document: unknown): Promise<SubmitAck>;
  fetchRemits(since: string): Promise<RemitEnvelope[]>;
}

export class FixtureClearinghouse implements ClearinghousePort {
  readonly calls: string[] = [];

  async checkEligibility(request: { memberId: string }): Promise<EligibilityResult> {
    this.calls.push("eligibility");
    return { eligible: request.memberId.startsWith("SYN"), memberId: request.memberId };
  }

  async submitClaim(_document: unknown): Promise<SubmitAck> {
    this.calls.push("submit");
    return { icn: "SYN-ICN", status: "accepted" };
  }

  async fetchRemits(): Promise<RemitEnvelope[]> {
    this.calls.push("remits");
    return [];
  }
}

export class StediClearinghouse implements ClearinghousePort {
  constructor(_apiKey: string) {}

  async checkEligibility(): Promise<EligibilityResult> {
    throw new Error("ClearinghouseDisabled: live adapter is not enabled in this prototype");
  }

  async submitClaim(): Promise<SubmitAck> {
    throw new Error("ClearinghouseDisabled: live adapter is not enabled in this prototype");
  }

  async fetchRemits(): Promise<RemitEnvelope[]> {
    throw new Error("ClearinghouseDisabled: live adapter is not enabled in this prototype");
  }
}
