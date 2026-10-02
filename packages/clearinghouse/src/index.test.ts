import { describe, expect, it } from "vitest";
import { buildClaimDocument, RemitEnvelopeSchema } from "@pt-rcm/domain";
import { makeClaimDocumentInput } from "../../domain/src/testing/claimDocument.js";
import { ClearinghouseDisabled, FixtureClearinghouse, StediClearinghouse, type ClearinghousePort } from "./index.js";

const document = () => buildClaimDocument(makeClaimDocumentInput());

describe("fixture clearinghouse", () => {
  it.each([["SYN-MEMBER", true], ["SYN", true], ["OTHER", false], ["", false], ["syn-member", false]] as const)("eligibility for %s is active=%s", async (memberId, active) => {
    const fixture = new FixtureClearinghouse();
    expect(await fixture.checkEligibility({ memberId })).toEqual({ eligible: active, coverageStatus: active ? "active" : "inactive", memberId });
    expect(fixture.calls).toEqual([{ method: "checkEligibility", request: { memberId } }]);
    expect(fixture.calls.some((call) => call.method === "submitClaim")).toBe(false);
  });

  it("accepts for processing with a fake ICN and records a detached document", async () => {
    const fixture = new FixtureClearinghouse();
    const doc = document();
    const before = structuredClone(doc);
    const ack = await fixture.submitClaim(doc);
    expect(ack).toEqual({ icn: `SYN-ICN-${doc.claimId}`, status: "accepted-for-processing" });
    doc.lines[0]!.modifiers.push("59");
    expect(fixture.calls).toEqual([{ method: "submitClaim", document: before }]);
  });

  it.each([
    [0, 0, 0], [1, 1, 0], [3, 2, 1], [101, 81, 20], [13500, 10800, 2700], [2147483647, 1717986918, 429496729],
  ])("scripts %i cents as %i paid and %i coinsurance", async (totalChargeCents, paidCents, patientResponsibilityCents) => {
    const script = { claimId: document().claimId, totalChargeCents, receivedOn: "2026-10-02" };
    const fixture = new FixtureClearinghouse(script);
    script.totalChargeCents = 99;
    const remits = await fixture.fetchRemits("2026-10-01");
    expect(remits).toEqual([{
      id: expect.any(String), lines: [],
      claimId: script.claimId, payerIcn: `SYN-ICN-${script.claimId}`, paidCents, patientResponsibilityCents,
      carc: "PR-2", adjustments: [{ carc: "PR-2", amountCents: patientResponsibilityCents }], receivedOn: "2026-10-02",
    }]);
    expect(paidCents + patientResponsibilityCents).toBe(totalChargeCents);
    expect(fixture.calls).toEqual([{ method: "fetchRemits", since: "2026-10-01" }]);
    remits[0]!.adjustments[0]!.amountCents = 0;
    expect((await fixture.fetchRemits("2026-10-01"))[0]!.patientResponsibilityCents).toBe(patientResponsibilityCents);
  });

  it.each([["2026-10-02", 1], ["2026-10-02T00:00:00.000Z", 1], ["2026-10-02T00:00:00.001Z", 0], ["2026-10-03", 0]] as const)("filters the scripted remit since %s", async (since, count) => {
    const fixture = new FixtureClearinghouse({ claimId: document().claimId, totalChargeCents: 13500, receivedOn: "2026-10-02" });
    expect(await fixture.fetchRemits(since)).toHaveLength(count);
  });
  it("records remit reads with no configured script", async () => {
    const fixture = new FixtureClearinghouse();
    expect(await fixture.fetchRemits("2026-10-01")).toEqual([]);
    expect(fixture.calls).toHaveLength(1);
  });
  it.each([-1, 1.5, NaN])("rejects invalid scripted cents %s", (totalChargeCents) => {
    expect(() => new FixtureClearinghouse({ claimId: document().claimId, totalChargeCents, receivedOn: "2026-10-02" })).toThrow();
  });
  it("scripts service lines, stable IDs, and detached batches without submitting", async () => {
    const doc = document();
    const script = { claimId: doc.claimId, claimVersion: 1, totalChargeCents: doc.totalChargeCents, receivedOn: "2026-10-02",
      lines: doc.lines.map(({ cptCode, units, chargeCents }) => ({ cptCode, units, chargeCents })) };
    const fixture = new FixtureClearinghouse([script]);
    const [remit] = await fixture.fetchRemits("2026-10-01");
    expect(RemitEnvelopeSchema.parse(remit)).toEqual(remit);
    expect(remit!.lines.map((line) => [line.cptCode, line.units, line.paidCents, line.patientResponsibilityCents])).toEqual([
      ["97110", 2, 7200, 1800], ["97530", 1, 3600, 900],
    ]);
    expect((await new FixtureClearinghouse(script).fetchRemits("2026-10-01"))[0]!.id).toBe(remit!.id);
    expect((await new FixtureClearinghouse({ ...script, claimVersion: 2 }).fetchRemits("2026-10-01"))[0]!.id).not.toBe(remit!.id);
    script.lines[0]!.units = 99;
    remit!.lines[0]!.paidCents = 0;
    expect((await fixture.fetchRemits("2026-10-01"))[0]!.lines[0]).toMatchObject({ units: 2, paidCents: 7200 });
    expect(fixture.calls.every((call) => call.method === "fetchRemits")).toBe(true);
  });
  it("keeps odd-cent service-line totals equal to the scripted claim total", async () => {
    const [remit] = await new FixtureClearinghouse({ claimId: document().claimId, totalChargeCents: 3, receivedOn: "2026-10-02",
      lines: [{ cptCode: "97110", units: 1, chargeCents: 1 }, { cptCode: "97530", units: 1, chargeCents: 2 }] }).fetchRemits("2026-10-01");
    expect(remit!.paidCents).toBe(2);
    expect(remit!.lines.reduce((sum, line) => sum + line.paidCents, 0)).toBe(2);
    expect(remit!.lines.reduce((sum, line) => sum + line.patientResponsibilityCents!, 0)).toBe(1);
  });
  it("rejects contradictory script charges", () => {
    expect(() => new FixtureClearinghouse({ claimId: document().claimId, totalChargeCents: 3, receivedOn: "2026-10-02",
      lines: [{ cptCode: "97110", units: 1, chargeCents: 1 }] })).toThrow("Fixture line charges must equal the claim charge");
  });
});

describe("disabled live clearinghouse", () => {
  it.each(["", "   ", undefined])("requires a supplied STEDI_API_KEY: %s", (apiKey) => {
    expect(() => new StediClearinghouse(apiKey as string)).toThrow("STEDI_API_KEY is required");
  });
  const live: ClearinghousePort = new StediClearinghouse("SYN-NOT-A-KEY");
  it.each([
    () => live.checkEligibility({ memberId: "SYN-1" }),
    () => live.submitClaim(document()),
    () => live.fetchRemits("2026-10-01"),
  ])("throws ClearinghouseDisabled for every operation", async (operation) => {
    await expect(operation()).rejects.toBeInstanceOf(ClearinghouseDisabled);
    await expect(operation()).rejects.toThrow("live adapter is not enabled in this prototype");
  });
});
