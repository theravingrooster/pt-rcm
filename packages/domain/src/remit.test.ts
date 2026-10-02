import { describe, expect, it } from "vitest";
import { ClaimStatusSchema } from "./models.js";
import { applyRemit, RemitEnvelopeSchema, RemitNotPostable } from "./remit.js";
import { makeRemitClaim, makeRemitEnvelope } from "./testing/remit.js";

describe("applyRemit", () => {
  it.each(["SUBMITTED", "ACCEPTED"] as const)("posts paid in full from %s via the lifecycle without mutating inputs", (status) => {
    const claim = { ...makeRemitClaim(), status }; const remit = makeRemitEnvelope(claim);
    const before = structuredClone({ claim, remit });
    const result = applyRemit(claim, remit);
    expect(result).toMatchObject({ matched: true, paidCents: 13500, patientResponsibilityCents: 0, adjustmentCents: 0,
      claim: { status: "PAID", version: 1 }, flags: [], tasks: [], transitions: status === "SUBMITTED" ? ["ACCEPTED", "PAID"] : ["PAID"] });
    expect(result.lines.map((line) => line.claimLineId)).toEqual(claim.lines.map((line) => line.id));
    expect({ claim, remit }).toEqual(before);
    expect(result.claim).not.toBe(claim);
  });

  it.each(["PR-1", "PR-2", "PR-3"])("moves %s amounts into patient responsibility without double counting the summary", (carc) => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim);
    remit.paidCents = 10800; remit.patientResponsibilityCents = 2700;
    remit.lines.forEach((line) => {
      line.patientResponsibilityCents = line.paidCents / 5; line.paidCents -= line.patientResponsibilityCents;
      line.adjustments = [{ carc, amountCents: line.patientResponsibilityCents }];
    });
    const result = applyRemit(claim, remit);
    expect(result).toMatchObject({ claim: { status: "PATIENT_BALANCE" }, paidCents: 10800, patientResponsibilityCents: 2700, adjustmentCents: 0, flags: [] });
    expect(result.lines.map((line) => line.patientResponsibilityCents)).toEqual([1800, 900]);
    delete remit.lines[0]!.patientResponsibilityCents;
    expect(applyRemit(claim, remit).patientResponsibilityCents).toBe(2700);
  });

  it("records a CO write-off without making it patient balance", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim);
    remit.paidCents = 10800;
    remit.lines.forEach((line) => { const amountCents = line.paidCents / 5; line.paidCents -= amountCents; line.adjustments = [{ carc: "CO-45", amountCents }]; });
    const result = applyRemit(claim, remit);
    expect(result).toMatchObject({ claim: { status: "PAID" }, patientResponsibilityCents: 0, adjustmentCents: 2700, flags: [] });
    expect(result.lines.map((line) => line.contractualWriteOffCents)).toEqual([1800, 900]);
  });

  it.each(["CO-4", "CO-16", "CO-50", "CO-197"])("denies zero-paid claims with %s", (carc) => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim); remit.paidCents = 0;
    remit.lines.forEach((line) => { line.adjustments = [{ carc, amountCents: line.paidCents }]; line.paidCents = 0; });
    expect(applyRemit(claim, remit)).toMatchObject({ claim: { status: "DENIED" }, adjustmentCents: 13500, patientResponsibilityCents: 0, flags: [] });
  });

  it("flags unbalanced amounts but keeps the actual amounts and payment outcome", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim);
    remit.lines[0]!.paidCents -= 1; remit.paidCents -= 1;
    const result = applyRemit(claim, remit);
    expect(result).toMatchObject({ claim: { status: "PAID" }, paidCents: 13499,
      flags: [{ outcome: "FLAG", code: "REMIT_OUT_OF_BALANCE", lineIndex: 0 }], tasks: [{ kind: "REMIT_OUT_OF_BALANCE" }] });
    expect(result.lines[0]!.paidCents).toBe(8999);
  });
  it("recognizes a claim-level CO-16 even if adjustment amounts are missing", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim);
    remit.carc = "CO-16"; remit.paidCents = 0; remit.lines.forEach((line) => { line.paidCents = 0; });
    const result = applyRemit(claim, remit);
    expect(result.claim.status).toBe("DENIED");
    expect(result.flags).toHaveLength(2);
    expect(result.adjustmentCents).toBe(0); // Never invent missing adjustment amounts.
  });
  it("keeps mixed PR and CO amounts in separate accounting categories", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim);
    remit.paidCents = 10500; remit.patientResponsibilityCents = 1000;
    remit.lines[0] = { ...remit.lines[0]!, paidCents: 6000, patientResponsibilityCents: 1000,
      adjustments: [{ carc: "CO-45", amountCents: 2000 }, { carc: "PR-2", amountCents: 1000 }] };
    expect(applyRemit(claim, remit)).toMatchObject({ claim: { status: "PATIENT_BALANCE" }, flags: [],
      paidCents: 10500, patientResponsibilityCents: 1000, adjustmentCents: 2000,
      lines: [{ patientResponsibilityCents: 1000, contractualWriteOffCents: 2000 }, { patientResponsibilityCents: 0 }] });
  });

  it.each(["duplicate claim", "duplicate remit", "wrong CPT", "wrong units", "partial", "empty"])("does not guess with %s lines", (scenario) => {
    const claim = { ...makeRemitClaim(), status: "SUBMITTED" as const }; const remit = makeRemitEnvelope(claim);
    if (scenario === "duplicate claim") claim.lines[1] = { ...claim.lines[0]!, id: claim.lines[1]!.id };
    if (scenario === "duplicate remit") remit.lines[1] = structuredClone(remit.lines[0]!);
    if (scenario === "wrong CPT") remit.lines[0]!.cptCode = "97140";
    if (scenario === "wrong units") remit.lines[0]!.units += 1;
    if (scenario === "partial") remit.lines.pop();
    if (scenario === "empty") remit.lines = [];
    expect(applyRemit(claim, remit)).toMatchObject({ matched: false, claim: { status: "SUBMITTED" }, lines: [], transitions: [], tasks: [{ kind: "REMIT_UNMATCHED" }] });
  });

  it("matches independently of line order", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim); remit.lines.reverse();
    expect(applyRemit(claim, remit).lines.map((line) => line.claimLineId)).toEqual([...claim.lines].reverse().map((line) => line.id));
  });

  it("retains status for a zero-payment adjustment without a listed denial code", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim); remit.paidCents = 0;
    remit.lines.forEach((line) => { line.adjustments = [{ carc: "OA-23", amountCents: line.paidCents }]; line.paidCents = 0; });
    expect(applyRemit(claim, remit)).toMatchObject({ claim: { status: "ACCEPTED" }, transitions: [], adjustmentCents: 13500, flags: [] });
  });

  it("keeps a positive payment out of DENIED even when a denial adjustment is present", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim);
    remit.lines[0]!.adjustments = [{ carc: "CO-16", amountCents: 9000 }]; remit.lines[0]!.paidCents = 0; remit.paidCents = 4500;
    expect(applyRemit(claim, remit).claim.status).toBe("PAID");
  });

  it("flags contradictory PR summaries and posts the coded amount only once", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim);
    remit.lines[0]!.adjustments = [{ carc: "PR-2", amountCents: 1800 }];
    remit.lines[0]!.paidCents = 7200; remit.paidCents = 11700;
    const result = applyRemit(claim, remit);
    expect(result.patientResponsibilityCents).toBe(1800);
    expect(result.flags).toHaveLength(2);
    expect(result.tasks).toHaveLength(1);
  });

  it.each(ClaimStatusSchema.options.filter((status) => status !== "SUBMITTED" && status !== "ACCEPTED"))("refuses a new remit for %s", (status) => {
    const claim = { ...makeRemitClaim(), status };
    expect(() => applyRemit(claim, makeRemitEnvelope(claim))).toThrow(RemitNotPostable);
  });
  it("rejects a remit for a different claim", () => {
    const claim = makeRemitClaim(); const remit = makeRemitEnvelope(claim); remit.claimId = remit.id;
    expect(() => applyRemit(claim, remit)).toThrow(RemitNotPostable);
  });
  it.each([-1, 0.5, NaN, 2147483648])("rejects invalid cents %s", (paidCents) => {
    const remit = makeRemitEnvelope(); remit.lines[0]!.paidCents = paidCents;
    expect(RemitEnvelopeSchema.safeParse(remit).success).toBe(false);
  });
});
