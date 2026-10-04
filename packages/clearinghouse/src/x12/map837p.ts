import { ClaimDocumentSchema, type ClaimDocument } from "@pt-rcm/domain";

/** These are the loops represented by this small fixture, not an 837P certification claim. */
export const MAP_837P_LOOPS = Object.freeze([
  { id: "1000A", name: "Submitter" },
  { id: "1000B", name: "Receiver" },
  { id: "2000A", name: "Billing provider hierarchy" },
  { id: "2000B", name: "Subscriber hierarchy" },
  { id: "2300", name: "Claim information" },
  { id: "2400", name: "Service line information" },
] as const);

export class Synthetic837DocumentError extends Error {
  readonly code = "INVALID_837_FIXTURE_DOCUMENT";
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "Synthetic837DocumentError";
  }
}

/** A readable, deliberately non-transmittable 837P-shaped synthetic fixture.
 * It has a non-X12 fixture marker and no interchange envelope. Money is stored
 * in cents on ClaimDocument and rendered as decimal dollars in X12-shaped fields.
 * This function never allocates units, changes CPT, submits, or sends data.
 */
export function map837p(document: ClaimDocument): string {
  const parsed = ClaimDocumentSchema.safeParse(document);
  if (!parsed.success) throw new Synthetic837DocumentError("Claim document is invalid for the synthetic 837P fixture");
  const claim = parsed.data;
  if (!claim.lines.length || !claim.diagnoses.length) throw new Synthetic837DocumentError("Synthetic 837P requires service lines and diagnoses");
  if (claim.subscriber.relationship !== "SELF" || !claim.subscriber.person) {
    // Non-self coverage has no subscriber demographics in ClaimDocument. Do not
    // invent them or silently substitute the patient's information.
    throw new Synthetic837DocumentError("Synthetic 837P requires recorded subscriber demographics");
  }

  const subscriber = claim.subscriber.person;
  const date = claim.dateOfService.replaceAll("-", "");
  const segments = [
    segment("ST", "837", "0001", "005010X222A1"),
    segment("BHT", "0019", "00", claim.claimControlNumber, date, "0000", "CH"),
    // 1000A submitter and 1000B fixture receiver.
    segment("NM1", "41", "2", plain(claim.submitter.name), "", "", "", "", "46", "SYN-SUBMITTER"),
    segment("NM1", "40", "2", plain(claim.receiver.name), "", "", "", "", "46", "SYN-FIXTURE"),
    // 2000A billing provider and 2000B subscriber.
    segment("HL", "1", "", "20", "1"),
    segment("NM1", "85", "2", plain(claim.billingProvider.name), "", "", "", "", "XX", claim.billingProvider.npi),
    segment("REF", "EI", claim.billingProvider.tin),
    segment("HL", "2", "1", "22", "0"),
    segment("SBR", "P", "18", "", "", "", "", "", "", claim.receiver.payerType === "MEDICARE" ? "MB" : "CI"),
    segment("NM1", "IL", "1", plain(subscriber.lastName), plain(subscriber.firstName), "", "", "", "MI", claim.subscriber.memberId),
    // 2300 claim, diagnoses, and its rendering provider identification.
    segment("CLM", claim.claimControlNumber, money(claim.totalChargeCents), "", "", `${claim.placeOfServiceCode}:B:1`,
      "Y", "A", claim.benefitsAssigned ? "Y" : "N", claim.acceptAssignment ? "Y" : "N"),
    segment("HI", ...claim.diagnoses.map((diagnosis) => `${diagnosis.primary ? "ABK" : "ABF"}:${diagnosis.icd10}`)),
    segment("NM1", "82", "1", "SYN RENDERING", "", "", "", "", "XX", claim.renderingProvider.npi),
  ];

  // 2400 service lines. Pointer conversion from internal zero-based values is
  // presentation only; it does not change the saved diagnosis relationships.
  claim.lines.forEach((line, index) => {
    segments.push(
      segment("LX", String(index + 1)),
      segment("SV1", ["HC", line.cptCode, ...line.modifiers].join(":"), money(line.chargeCents), "UN", String(line.units),
        "", "", line.diagnosisPointers.map((pointer) => pointer + 1).join(":")),
      segment("DTP", "472", "D8", date),
    );
  });
  segments.push(segment("SE", String(segments.length + 1), "0001"));
  return `${[segment("SYN", "FIXTURE-ONLY", "NOT-FOR-PAYER-SUBMISSION"), ...segments].map((value) => `${value}~`).join("\n")}\n`;
}

function segment(tag: string, ...fields: string[]): string {
  if (fields.some((field) => /[\r\n*~]/.test(field))) throw new Synthetic837DocumentError("Synthetic 837P field contains a segment delimiter");
  return [tag, ...fields].join("*");
}

function plain(field: string): string {
  if (field.includes(":")) throw new Synthetic837DocumentError("Synthetic 837P field contains a component delimiter");
  return field;
}

function money(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
