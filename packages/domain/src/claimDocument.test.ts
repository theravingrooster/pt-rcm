import { describe, expect, it } from "vitest";
import { allocateUnits, buildClaimDocument, ClaimDocumentSchema, ClaimNotSubmittable, ClaimStatusSchema, loadMedicareMinuteLadder, renderClaimDocumentJson } from "./index.js";
import { makeClaimDocumentInput } from "./testing/claimDocument.js";

describe("internal ClaimDocument", () => {
  it("builds a validated synthetic document from saved units, GP, charges and zero-based pointers", () => {
    const source = makeClaimDocumentInput();
    const before = structuredClone(source);
    const doc = buildClaimDocument(source);
    expect(ClaimDocumentSchema.parse(doc)).toEqual(doc);
    expect(doc).toMatchObject({
      submitter: { name: "SYN Ortho PT" }, receiver: { id: source.payer.id, name: "Medicare" },
      billingProvider: { npi: "0000000001", tin: "SYN-TAX-1", taxonomyCode: "225100000X", address: source.organization.address },
      renderingProvider: { npi: "0000000003" }, serviceFacility: { npi: "0000000002", address: source.serviceFacility.address }, placeOfServiceCode: "11",
      subscriber: { memberId: "SYN-MEMBER-DOCUMENT", relationship: "SELF", person: { firstName: "SYN", dob: "2000-01-01" } },
      patient: { externalId: "SYN-PATIENT-DOCUMENT" }, claimControlNumber: "SYN000000000020",
      dateOfService: "2026-10-01", diagnoses: [{ icd10: "M25.511", pointer: 0, primary: true }],
      totalChargeCents: 13500, benefitsAssigned: true, acceptAssignment: true,
    });
    const allocation = allocateUnits(source.claimLines.map((line) => ({ ...line, timed: true })), loadMedicareMinuteLadder());
    expect(doc.lines.map((line) => line.units)).toEqual(allocation.lines.map((line) => line.units));
    expect(doc.lines.map((line) => [line.cptCode, line.modifiers, line.units, line.chargeCents, line.diagnosisPointers])).toEqual([
      ["97110", ["GP"], 2, 9000, [0]], ["97530", ["GP"], 1, 4500, [0]],
    ]);
    expect(buildClaimDocument(source)).toEqual(doc);
    doc.lines[0]!.modifiers.push("59");
    doc.billingProvider.address.city = "SYN Changed";
    expect(source).toEqual(before);
  });

  it.each(ClaimStatusSchema.options.filter((status) => status !== "SCRUBBED"))("refuses %s with ClaimNotSubmittable", (status) => {
    const source = makeClaimDocumentInput(); source.claim.status = status;
    expect(() => buildClaimDocument(source)).toThrow(ClaimNotSubmittable);
    expect(() => buildClaimDocument(source)).toThrow(`Claim status ${status}`);
  });

  it("preserves reviewed underbilling, modifiers and charges without reallocating or repricing", () => {
    const source = makeClaimDocumentInput();
    source.claimLines[0]!.units = 1;
    source.claimLines[0]!.modifiers = ["GP", "59"];
    source.claimLines[0]!.chargeCents = 4200;
    source.claim.totalChargeCents = 8700;
    expect(buildClaimDocument(source).lines[0]).toMatchObject({ units: 1, modifiers: ["GP", "59"], chargeCents: 4200 });
  });

  it.each(["SPOUSE", "CHILD", "OTHER"] as const)("does not invent subscriber demographics for %s coverage", (relationship) => {
    const source = makeClaimDocumentInput(); source.coverage.subscriberRelationship = relationship;
    const doc = buildClaimDocument(source);
    expect(doc.subscriber).toMatchObject({ relationship, person: null });
    expect(doc.patient.firstName).toBe("SYN");
  });

  it("defaults assignment flags while preserving explicit false", () => {
    const source = makeClaimDocumentInput();
    const doc = buildClaimDocument({ ...source, benefitsAssigned: false, acceptAssignment: false });
    expect(doc.benefitsAssigned).toBe(false); expect(doc.acceptAssignment).toBe(false);
    const { benefitsAssigned: _benefits, acceptAssignment: _accept, ...withoutDefaults } = doc;
    expect(ClaimDocumentSchema.parse(withoutDefaults)).toMatchObject({ benefitsAssigned: true, acceptAssignment: true });
  });

  it.each([
    { totalChargeCents: 1 }, { totalChargeCents: 13500.5 }, { claimControlNumber: "LIVE123" },
    { dateOfService: "2026-02-30" }, { renderingProvider: { npi: "1234567890" } },
    { billingProvider: { name: "SYN", npi: "0000000001", tin: "12-3456789", taxonomyCode: "225100000X", address: {} } },
  ])("rejects invalid document fields %#", (override) => {
    expect(ClaimDocumentSchema.safeParse({ ...buildClaimDocument(makeClaimDocumentInput()), ...override }).success).toBe(false);
  });

  it.each([{ units: 0 }, { units: 1.5 }, { chargeCents: -1 }, { modifiers: ["INVALID"] }, { diagnosisPointers: [99] }])("rejects invalid or dangling line values %j", (override) => {
    const doc = buildClaimDocument(makeClaimDocumentInput());
    expect(ClaimDocumentSchema.safeParse({ ...doc, lines: [{ ...doc.lines[0], ...override }, doc.lines[1]] }).success).toBe(false);
  });

  it("rejects duplicate diagnosis pointers", () => {
    const doc = buildClaimDocument(makeClaimDocumentInput());
    expect(ClaimDocumentSchema.safeParse({ ...doc, diagnoses: [...doc.diagnoses, ...doc.diagnoses] }).success).toBe(false);
  });

  it.each(["patient", "payer", "organization", "renderingProvider", "serviceFacility"] as const)("rejects a mismatched %s source", (key) => {
    const source = makeClaimDocumentInput(); source[key].id = "99999999-0000-4000-8000-000000000099";
    expect(() => buildClaimDocument(source)).toThrow();
  });

  it("rejects claim lines or diagnoses from another claim/encounter", () => {
    const source = makeClaimDocumentInput(); source.claimLines[0]!.claimId = source.patient.id;
    expect(() => buildClaimDocument(source)).toThrow();
    source.claimLines[0]!.claimId = source.claim.id; source.diagnoses[0]!.encounterId = source.patient.id;
    expect(() => buildClaimDocument(source)).toThrow();
  });

  it("renders deterministic, pretty JSON with a trailing newline and revalidates", () => {
    const doc = buildClaimDocument(makeClaimDocumentInput());
    const rendered = renderClaimDocumentJson(doc);
    expect(rendered).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    expect(JSON.parse(rendered)).toEqual(doc);
    expect(() => renderClaimDocumentJson({ ...doc, totalChargeCents: -1 })).toThrow();
  });
});
