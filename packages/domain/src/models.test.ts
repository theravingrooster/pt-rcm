import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as d from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const address: d.Address = {
  line1: "1 SYN Test Way", line2: null, city: "SYN City",
  state: "CA", postalCode: "00000", country: "US",
};
const cases: { name: string; schema: z.ZodTypeAny; valid: Record<string, unknown>; invalid: Record<string, unknown> }[] = [
  { name: "Organization", schema: d.OrganizationSchema,
    valid: { id, name: "SYN Ortho PT", billingNpi: "0000000001", taxId: "SYN-TAX-1", taxonomyCode: "225100000X", address },
    invalid: { billingNpi: "1234567890" } },
  { name: "ServiceFacility", schema: d.ServiceFacilitySchema,
    valid: { id, organizationId: id, name: "SYN Facility", npi: "0000000002", address },
    invalid: { placeOfServiceCode: "office" } },
  { name: "Provider", schema: d.ProviderSchema,
    valid: { id, organizationId: id, firstName: "SYN", lastName: "Provider", npi: "0000000003", taxonomyCode: "225100000X", role: "RENDERING" },
    invalid: { role: "UNKNOWN" } },
  { name: "Patient", schema: d.PatientSchema,
    valid: { id, organizationId: id, externalId: "SYN-PATIENT-1", firstName: "SYN", lastName: "Patient", dob: "2000-02-29", sex: "U", address },
    invalid: { dob: "2001-02-29" } },
  { name: "Coverage", schema: d.CoverageSchema,
    valid: { id, patientId: id, payerId: id, memberId: "SYN-MEMBER-1", groupNumber: "SYN-GROUP", subscriberRelationship: "SELF", planName: "SYN Plan", active: true },
    invalid: { memberId: "MEMBER-1" } },
  { name: "Payer", schema: d.PayerSchema,
    valid: { id, name: "SYN Commercial", payerType: "COMMERCIAL", stediPayerId: null, requiresGpModifier: false },
    invalid: { requiresGpModifier: "false" } },
  { name: "Encounter", schema: d.EncounterSchema,
    valid: { id, organizationId: id, externalId: "SYN-ENC-1", patientId: id, renderingProviderId: id, facilityId: id, dateOfService: "2026-10-01", status: "DRAFT" },
    invalid: { status: "SUBMITTED" } },
  // CPT is licensed from the AMA. This single code fixture is for local tests only.
  { name: "EncounterMinuteLine", schema: d.EncounterMinuteLineSchema,
    valid: { id, encounterId: id, cptCode: "97110", minutes: 15, timed: true, notes: null },
    invalid: { minutes: -1 } },
  { name: "Diagnosis", schema: d.DiagnosisSchema,
    valid: { id, encounterId: id, icd10: "M25.561", pointer: 0, primary: true },
    invalid: { pointer: -1 } },
  { name: "Authorization", schema: d.AuthorizationSchema,
    valid: { id, patientId: id, payerId: id, cptFamily: "SYN-PT", visitsAuthorized: 6, visitsUsed: 7, startDate: "2026-01-01", endDate: "2026-12-31" },
    invalid: { endDate: "2025-12-31" } },
  { name: "PlanOfCare", schema: d.PlanOfCareSchema,
    valid: { id, patientId: id, signedDate: "2026-01-01", certifyingNpi: "0000000004", expiresOn: "2026-04-01" },
    invalid: { expiresOn: "2025-12-31" } },
  { name: "Claim", schema: d.ClaimSchema,
    valid: { id, encounterId: id, version: 1, status: "DRAFT", payerId: id, totalChargeCents: 15000, snapshotJson: { source: "SYN", lines: [{ minutes: 15 }] } },
    invalid: { totalChargeCents: 150.5 } },
  { name: "ClaimLine", schema: d.ClaimLineSchema,
    valid: { id, claimId: id, cptCode: "97110", modifiers: ["GP"], units: 1, chargeCents: 15000, diagnosisPointers: [0], minutes: 15 },
    invalid: { diagnosisPointers: [0, -1] } },
  { name: "RuleSet", schema: d.RuleSetSchema,
    valid: { id, version: "1.0.0", status: "SHADOW", notes: "SYN fixture; no rule execution" },
    invalid: { version: "" } },
  { name: "RuleFire", schema: d.RuleFireSchema,
    valid: { id, claimId: id, ruleId: "SYN-RULE", ruleVersion: "1.0.0", outcome: "FLAG", shadow: true, detailJson: { test: true }, createdAt: "2026-10-01T12:00:00.000Z" },
    invalid: { createdAt: "2026-10-01T12:00:00-07:00" } },
  { name: "Remit", schema: d.RemitSchema,
    valid: { id, claimId: id, payerIcn: "SYN-ICN", paidCents: 12000, patientResponsibilityCents: 3000, receivedOn: "2026-10-02" },
    invalid: { paidCents: -1 } },
  { name: "RemitLine", schema: d.RemitLineSchema,
    valid: { id, remitId: id, claimLineId: id, paidCents: 12000, carc: "1", rarc: null },
    invalid: { paidCents: 1.5 } },
  { name: "Task", schema: d.TaskSchema,
    valid: { id, claimId: id, kind: "SYN-REVIEW", owner: "OPERATOR", status: "OPEN", reason: "SYN review task" },
    invalid: { owner: "PAYER" } },
  { name: "AuditEvent", schema: d.AuditEventSchema,
    valid: { id, actor: "SYN-OPERATOR", action: "CREATE", entity: "Claim", entityId: id, at: "2026-10-01T12:00:00.000Z", detailJson: { synthetic: true } },
    invalid: { detailJson: { invalid: undefined } } },
];

describe.each(cases)("$name", ({ schema, valid, invalid }) => {
  it("accepts a synthetic canonical object", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });
  it("rejects an invalid object", () => {
    expect(schema.safeParse({ ...valid, ...invalid }).success).toBe(false);
  });
});

describe("shared value schemas", () => {
  it("defaults facility POS to 11 without inventing clinical data", () => {
    expect(d.ServiceFacilitySchema.parse(cases[1]!.valid).placeOfServiceCode).toBe("11");
  });
  it.each([-1, 0.01, NaN, Infinity, 2_147_483_648, "100"])("rejects invalid cents %s", (value) => {
    expect(d.MoneyCentsSchema.safeParse(value).success).toBe(false);
  });
  it.each([0, 1, 2_147_483_647])("accepts integer cents %s", (value) => {
    expect(d.MoneyCentsSchema.parse(value)).toBe(value);
  });
  it.each(["2026-2-01", "2026-02-30", "2026-10-01T00:00:00Z", "0000-01-01"])("rejects invalid date %s", (value) => {
    expect(d.IsoDateSchema.safeParse(value).success).toBe(false);
  });
  it.each(["000000001", "00000000001", "000000000X", "1234567890"])("rejects invalid synthetic NPI %s", (value) => {
    expect(d.NpiSchema.safeParse(value).success).toBe(false);
  });
  it("rejects a non-synthetic tax ID", () => {
    expect(d.TaxIdSchema.safeParse("12-3456789").success).toBe(false);
  });
  it.each([undefined, new Date(), () => 1, NaN, Infinity, 1n])("rejects non-JSON metadata %s", (value) => {
    expect(d.JsonObjectSchema.safeParse({ value }).success).toBe(false);
  });
  it("validates the shared address", () => {
    expect(d.AddressSchema.safeParse(address).success).toBe(true);
    expect(d.AddressSchema.safeParse({ ...address, postalCode: "invalid" }).success).toBe(false);
  });
  it("requires explicitly supplied clinical values", () => {
    expect(d.EncounterMinuteLineSchema.safeParse({ ...cases[7]!.valid, minutes: undefined }).success).toBe(false);
    expect(d.ClaimLineSchema.safeParse({ ...cases[12]!.valid, units: undefined }).success).toBe(false);
  });
  it("exports named enums for consumers", () => {
    expect(d.ProviderRole.RENDERING).toBe("RENDERING");
    expect(d.ClaimStatus.PATIENT_BALANCE).toBe("PATIENT_BALANCE");
    expect(d.RuleOutcome.DOWNGRADE).toBe("DOWNGRADE");
  });
});
