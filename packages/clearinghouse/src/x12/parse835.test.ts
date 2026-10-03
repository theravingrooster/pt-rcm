import { describe, expect, it } from "vitest";
import { RemitEnvelopeSchema } from "@pt-rcm/domain";
import { FixtureClearinghouse } from "../index.js";
import { parseSynthetic835, renderFixture835 } from "./parse835.js";

const claimId = "00000000-0000-4000-8000-000000000101";
const remitId = "00000000-0000-4000-8000-000000000102";
const payerIcn = `SYN-ICN-${claimId}`;

function text835({ paid, patient, serviceCas = "" }: {
  paid: string; patient: string; serviceCas?: string;
}): string {
  const transaction = [
    "ST*835*0001~",
    `BPR*I*${paid}*C*CHK~`,
    `TRN*1*${remitId}~`,
    "DTM*405*20261002~",
    `CLP*${claimId}*1*100.00*${paid}*${patient}**${payerIcn}~`,
    `SVC*HC:97110*100.00*${paid}**2~`,
    serviceCas,
  ].filter(Boolean);
  return [
    "ISA*00*          *00*          *ZZ*SYN-PAYER      *ZZ*SYN-PROVIDER   *261002*1200*^*00501*000000001*0*T*:~",
    "GS*HP*SYN-PAYER*SYN-PROVIDER*20261002*1200*1*X*005010X221A1~",
    ...transaction,
    `SE*${transaction.length + 1}*0001~`,
    "GE*1*1~",
    "IEA*1*000000001~",
  ].join("\n");
}

describe("synthetic 835 parser", () => {
  it.each([
    { name: "paid in full", input: text835({ paid: "100.00", patient: "0.00" }),
      paidCents: 10000, patientResponsibilityCents: 0, carc: undefined, adjustments: [] },
    { name: "80/20 coinsurance", input: text835({ paid: "80.00", patient: "20.00", serviceCas: "CAS*PR*2*20.00~" }),
      paidCents: 8000, patientResponsibilityCents: 2000, carc: "PR-2", adjustments: [{ carc: "PR-2", amountCents: 2000 }] },
    { name: "CO-16 denial", input: text835({ paid: "0.00", patient: "0.00", serviceCas: "CAS*CO*16*100.00~" }),
      paidCents: 0, patientResponsibilityCents: 0, carc: "CO-16", adjustments: [{ carc: "CO-16", amountCents: 10000 }] },
  ])("parses a $name remit into the existing envelope", ({ input, paidCents, patientResponsibilityCents, carc, adjustments }) => {
    const remit = parseSynthetic835(input);
    expect(RemitEnvelopeSchema.parse(remit)).toEqual(remit);
    expect(remit).toMatchObject({ id: remitId, claimId, payerIcn, receivedOn: "2026-10-02", paidCents, patientResponsibilityCents,
      adjustments, lines: [{ cptCode: "97110", units: 2, paidCents, patientResponsibilityCents, adjustments, rarc: null }] });
    expect(remit.carc).toBe(carc);
  });

  it("rejects a service line when paid plus PR and CO amounts do not equal charge", () => {
    const balanced = text835({ paid: "80.00", patient: "20.00", serviceCas: "CAS*PR*2*20.00~" });
    expect(() => parseSynthetic835(balanced.replace("SVC*HC:97110*100.00*80.00**2", "SVC*HC:97110*100.00*79.00**2"))).toThrow();
  });

  it("rejects a claim summary when paid plus adjustment and patient amounts do not equal charge", () => {
    const balanced = text835({ paid: "80.00", patient: "20.00", serviceCas: "CAS*PR*2*20.00~" });
    expect(() => parseSynthetic835(balanced.replace(`CLP*${claimId}*1*100.00*80.00*20.00`, `CLP*${claimId}*1*101.00*80.00*20.00`))).toThrow();
  });

  it("rejects the old hand-built JSON source even when it looks like a valid envelope", () => {
    const envelope = {
      id: remitId, claimId, payerIcn, receivedOn: "2026-10-02", paidCents: 10000, patientResponsibilityCents: 0,
      adjustments: [], lines: [{ cptCode: "97110", units: 2, paidCents: 10000, patientResponsibilityCents: 0, adjustments: [], rarc: null }],
    };
    expect(RemitEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() => parseSynthetic835(JSON.stringify(envelope))).toThrow();
  });

  it("uses the raw 835 text as the fixture adapter source", async () => {
    const rawText = text835({ paid: "80.00", patient: "20.00", serviceCas: "CAS*PR*2*20.00~" });
    const fixture = new FixtureClearinghouse(rawText);
    const [remit] = await fixture.fetchRemits("2026-10-01");
    expect(remit).toEqual(parseSynthetic835(rawText));
    expect((await fixture.fetchRemits("2026-10-03"))).toEqual([]);
  });

  it("does not let the fixture adapter substitute a JSON envelope for 835 text", async () => {
    const fixture = new FixtureClearinghouse(JSON.stringify({ id: remitId, claimId, paidCents: 10000 }));
    await expect(fixture.fetchRemits("2026-10-01")).rejects.toThrow();
  });

  it.each([
    ["PAID", 10000, 0, undefined],
    ["COINSURANCE", 8000, 2000, "PR-2"],
    ["DENIED", 0, 0, "CO-16"],
  ] as const)("renders and parses a %s service-line text fixture", (outcome, paidCents, patientResponsibilityCents, carc) => {
    const rawText = renderFixture835({ claimId, claimVersion: 2, totalChargeCents: 10000,
      receivedOn: "2026-10-02", lines: [{ cptCode: "97110", units: 2, chargeCents: 10000 }], outcome });
    expect(rawText).toContain("ST*835*0001~");
    expect(rawText).toContain("SVC*HC:97110*");
    expect(rawText).not.toContain("{\"id\"");
    const remit = parseSynthetic835(rawText);
    expect(remit).toMatchObject({ claimId, paidCents, patientResponsibilityCents, lines: [{ cptCode: "97110", paidCents }] });
    expect(remit.carc).toBe(carc);
  });

  it("rejects a mismatched transaction count or control number", () => {
    const balanced = text835({ paid: "100.00", patient: "0.00" });
    expect(() => parseSynthetic835(balanced.replace(/SE\*\d+\*0001/, "SE*999*0001"))).toThrow();
    expect(() => parseSynthetic835(balanced.replace(/SE\*\d+\*0001/, "SE*7*0002"))).toThrow();
  });
});
