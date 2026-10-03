import { createHash } from "node:crypto";
import {
  ClaimDocumentLineSchema, IdSchema, IsoDateSchema, MoneyCentsSchema, NonNegativeIntSchema,
  RemitEnvelopeSchema, type RemitAdjustment, type RemitEnvelope, type RemitServiceLine,
} from "@pt-rcm/domain";
import type { FixtureRemitScript } from "../index.js";

/** A deliberately small synthetic 835 subset, not a general X12 translator.
 * One transaction has one claim. Service-level CAS segments are authoritative;
 * claim-level CAS is accepted only when the fixture has no SVC lines.
 */
export function parseSynthetic835(text: string): RemitEnvelope {
  if (typeof text !== "string" || !text.trim().endsWith("~")) throw new Error("Synthetic 835 requires tilde-terminated segments");
  const segments = text.trim().split("~").slice(0, -1).map((raw) => raw.trim().split("*"));
  if (segments.some((segment) => !segment[0])) throw new Error("Synthetic 835 contains an empty segment");
  const tags = segments.map((segment) => segment[0]);
  if (tags.slice(0, 3).join(",") !== "ISA,GS,ST" || segments[1]?.[1] !== "HP" || segments[2]?.[1] !== "835"
    || tags.slice(-3).join(",") !== "SE,GE,IEA") {
    throw new Error("Expected an ISA/GS/ST 835 envelope with SE/GE/IEA trailers");
  }
  if (!/^\d+$/.test(segments.at(-3)?.[1] ?? "") || Number(segments.at(-3)?.[1]) !== segments.length - 4
    || segments[2]?.[2] !== segments.at(-3)?.[2]
    || segments[1]?.[6] !== segments.at(-2)?.[2]
    || segments[0]?.[13] !== segments.at(-1)?.[2]) {
    throw new Error("Synthetic 835 segment count or interchange control number does not match");
  }
  const body = segments.slice(3, -3);
  if (body.map((segment) => segment[0]).filter((tag) => tag === "CLP").length !== 1) {
    throw new Error("Synthetic 835 requires exactly one CLP claim");
  }
  let bpr: number | undefined;
  let id: string | undefined;
  let receivedOn: string | undefined;
  let claimId: string | undefined;
  let payerIcn: string | undefined;
  let chargeCents: number | undefined;
  let paidCents: number | undefined;
  let patientResponsibilityCents: number | undefined;
  let claimStatus: string | undefined;
  const claimAdjustments: RemitAdjustment[] = [];
  const serviceLines: (RemitServiceLine & { chargeCents: number })[] = [];
  let line: (RemitServiceLine & { chargeCents: number }) | undefined;
  let seenClaim = false;
  for (const segment of body) {
    const [tag, ...fields] = segment;
    switch (tag) {
      case "BPR":
        if (bpr !== undefined || seenClaim || fields[0] !== "I") throw new Error("Invalid synthetic 835 BPR");
        bpr = cents(fields[1]);
        break;
      case "TRN":
        if (id !== undefined || seenClaim || fields[0] !== "1") throw new Error("Invalid synthetic 835 TRN");
        id = IdSchema.parse(fields[1]);
        break;
      case "DTM":
        if (receivedOn !== undefined || seenClaim || fields[0] !== "405" || !/^\d{8}$/.test(fields[1] ?? "")) {
          throw new Error("Synthetic 835 requires one received date DTM*405");
        }
        receivedOn = IsoDateSchema.parse(`${fields[1]?.slice(0, 4)}-${fields[1]?.slice(4, 6)}-${fields[1]?.slice(6, 8)}`);
        break;
      case "CLP":
        if (seenClaim || bpr === undefined || id === undefined || receivedOn === undefined || !["1", "4"].includes(fields[1] ?? "")) {
          throw new Error("Invalid synthetic 835 CLP");
        }
        seenClaim = true;
        claimId = IdSchema.parse(fields[0]);
        claimStatus = fields[1];
        chargeCents = cents(fields[2]);
        paidCents = cents(fields[3]);
        patientResponsibilityCents = cents(fields[4]);
        payerIcn = fields[6];
        if (!payerIcn?.startsWith("SYN-ICN-")) throw new Error("Synthetic 835 requires a synthetic payer ICN");
        break;
      case "SVC": {
        if (!seenClaim || fields.length < 5 || !fields[0]?.startsWith("HC:")) throw new Error("Invalid synthetic 835 SVC");
        const cptCode = fields[0].slice(3);
        if (!/^[1-9]\d*$/.test(fields[4] ?? "")) throw new Error("Invalid synthetic 835 service units");
        const units = NonNegativeIntSchema.min(1).parse(Number(fields[4]));
        const charge = cents(fields[1]);
        const paid = cents(fields[2]);
        line = { cptCode: ClaimDocumentLineSchema.shape.cptCode.parse(cptCode), units, chargeCents: charge,
          paidCents: paid, patientResponsibilityCents: 0, adjustments: [], rarc: null };
        serviceLines.push(line);
        break;
      }
      case "CAS": {
        if (!seenClaim || fields.length !== 3 || !["PR", "CO", "OA", "PI"].includes(fields[0] ?? "")
          || !/^\d+$/.test(fields[1] ?? "")) throw new Error("Invalid synthetic 835 CAS");
        const adjustment = { carc: `${fields[0]}-${fields[1]}`, amountCents: cents(fields[2]) };
        (line ? line.adjustments : claimAdjustments).push(adjustment);
        break;
      }
      case "LQ":
        if (!line || fields[0] !== "HE" || !fields[1]) throw new Error("Invalid synthetic 835 remark");
        line.rarc = fields[1];
        break;
      default:
        throw new Error(`Unsupported synthetic 835 segment ${tag}`);
    }
  }
  if (!seenClaim || bpr === undefined || id === undefined || receivedOn === undefined || claimId === undefined
    || payerIcn === undefined || chargeCents === undefined || paidCents === undefined || patientResponsibilityCents === undefined) {
    throw new Error("Incomplete synthetic 835 claim");
  }
  if (bpr !== paidCents) throw new Error("BPR payment differs from CLP payment");
  if (serviceLines.length && claimAdjustments.length) throw new Error("Claim-level and service-level CAS cannot both be present in this fixture");
  for (const service of serviceLines) {
    const pr = sum(service.adjustments.filter((adjustment) => adjustment.carc.startsWith("PR-")).map((adjustment) => adjustment.amountCents));
    const other = sum(service.adjustments.filter((adjustment) => !adjustment.carc.startsWith("PR-")).map((adjustment) => adjustment.amountCents));
    if (service.chargeCents !== service.paidCents + other + pr) throw new Error("Synthetic 835 SVC line is out of balance");
    service.patientResponsibilityCents = pr;
  }
  const adjustments = serviceLines.length
    ? aggregate(serviceLines.flatMap((service) => service.adjustments)) : claimAdjustments;
  const pr = sum(adjustments.filter((adjustment) => adjustment.carc.startsWith("PR-")).map((adjustment) => adjustment.amountCents));
  const other = sum(adjustments.filter((adjustment) => !adjustment.carc.startsWith("PR-")).map((adjustment) => adjustment.amountCents));
  if (pr !== patientResponsibilityCents || chargeCents !== paidCents + other + patientResponsibilityCents) {
    throw new Error("Synthetic 835 CLP claim is out of balance");
  }
  if (serviceLines.length && (sum(serviceLines.map((service) => service.chargeCents)) !== chargeCents
    || sum(serviceLines.map((service) => service.paidCents)) !== paidCents
    || sum(serviceLines.map((service) => service.patientResponsibilityCents ?? 0)) !== patientResponsibilityCents)) {
    throw new Error("Synthetic 835 CLP totals differ from SVC lines");
  }
  if (claimStatus === "4" && paidCents !== 0) throw new Error("Reversal or denial status cannot carry a payment in this fixture");
  const [firstCarc] = adjustments;
  return RemitEnvelopeSchema.parse({ id, claimId, payerIcn, receivedOn, paidCents, patientResponsibilityCents,
    ...(firstCarc ? { carc: firstCarc.carc } : {}), adjustments,
    lines: serviceLines.map(({ chargeCents: _chargeCents, ...service }) => service),
  });
}

/** Build a synthetic 835-shaped text fixture from the submitted claim metadata.
 * The adapter parses this text before posting; this renderer never posts JSON.
 */
export function renderFixture835(script: FixtureRemitScript): string {
  const claimId = IdSchema.parse(script.claimId);
  const claimVersion = NonNegativeIntSchema.min(1).parse(script.claimVersion ?? 1);
  const totalChargeCents = MoneyCentsSchema.parse(script.totalChargeCents);
  const receivedOn = IsoDateSchema.parse(script.receivedOn);
  const outcome = script.outcome ?? "COINSURANCE";
  if (!["COINSURANCE", "PAID", "DENIED"].includes(outcome)) throw new Error("Invalid synthetic 835 outcome");
  const lines = script.lines?.map((value) => ClaimDocumentLineSchema.pick({ cptCode: true, units: true, chargeCents: true }).parse(value));
  if (lines && sum(lines.map((value) => value.chargeCents)) !== totalChargeCents) {
    throw new Error("Fixture line charges must equal the claim charge");
  }
  // Round cumulative charges so odd-cent service allocations exactly match CLP.
  const paidCents = outcome === "PAID" ? totalChargeCents
    : outcome === "DENIED" ? 0 : Math.floor((totalChargeCents * 80 + 50) / 100);
  const patientCents = outcome === "COINSURANCE" ? totalChargeCents - paidCents : 0;
  const hash = createHash("sha256").update(`SYN-REMIT:${claimId}:${claimVersion}`).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const segments = [
    "ISA*00*SYNTHETIC*00*SYNTHETIC*ZZ*SYN-FIXTURE*ZZ*SYN-OPERATOR*261002*0000*^*00501*000000001*0*T*:",
    "GS*HP*SYN-FIXTURE*SYN-OPERATOR*20261002*0000*1*X*005010X221A1",
    "ST*835*0001", `BPR*I*${money(paidCents)}*C*CHK`, `TRN*1*${id}`,
    `DTM*405*${receivedOn.replaceAll("-", "")}`,
    `CLP*${claimId}*1*${money(totalChargeCents)}*${money(paidCents)}*${money(patientCents)}*MC*SYN-ICN-${claimId}`,
  ];
  if (lines?.length) {
    let cumulativeCharge = 0;
    let cumulativePaid = 0;
    for (const value of lines) {
      cumulativeCharge += value.chargeCents;
      const nextPaid = outcome === "PAID" ? cumulativeCharge
        : outcome === "DENIED" ? 0 : Math.floor((cumulativeCharge * 80 + 50) / 100);
      const paid = nextPaid - cumulativePaid;
      cumulativePaid = nextPaid;
      segments.push(`SVC*HC:${value.cptCode}*${money(value.chargeCents)}*${money(paid)}**${value.units}`);
      if (outcome === "COINSURANCE") segments.push(`CAS*PR*2*${money(value.chargeCents - paid)}`);
      if (outcome === "DENIED") segments.push(`CAS*CO*16*${money(value.chargeCents)}`, "LQ*HE*N123");
    }
  } else {
    if (outcome === "COINSURANCE") segments.push(`CAS*PR*2*${money(patientCents)}`);
    if (outcome === "DENIED") segments.push(`CAS*CO*16*${money(totalChargeCents)}`);
  }
  segments.push(`SE*${segments.length - 1}*0001`, "GE*1*1", "IEA*1*000000001");
  return `${segments.join("~")}~`;
}

function cents(value: string | undefined): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value ?? "")) throw new Error("Synthetic 835 amount must have at most two decimal places");
  const [whole, fraction = ""] = value!.split(".");
  return MoneyCentsSchema.parse(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
}

function money(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }

function aggregate(adjustments: RemitAdjustment[]): RemitAdjustment[] {
  const byCarc = new Map<string, number>();
  for (const { carc, amountCents } of adjustments) byCarc.set(carc, (byCarc.get(carc) ?? 0) + amountCents);
  return [...byCarc].map(([carc, amountCents]) => ({ carc, amountCents: MoneyCentsSchema.parse(amountCents) }));
}
