import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EncounterIngestSchema, type EncounterIngestInput } from "./encounter-ingest.js";
import { CoverageSchema, PlanOfCareSchema } from "./models.js";

const example = JSON.parse(readFileSync(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8")) as EncounterIngestInput;

describe("synthetic encounter ingest contract", () => {
  it("accepts the demo without allocating units or changing minutes", () => {
    const result = EncounterIngestSchema.parse(example);
    expect(result.minuteLines).toEqual(example.minuteLines);
    expect(result.patient.name).toEqual({ firstName: "SYN", lastName: "Shoulder Demo" });
  });
  it("accepts a full name without losing words", () => {
    const result = EncounterIngestSchema.parse({ ...example, patient: { ...example.patient, name: " SYN Shoulder Demo " } });
    expect(result.patient.name).toEqual({ firstName: "SYN", lastName: "Shoulder Demo" });
  });
  it.each([
    ["97110", 0, true], ["97110", 480, true], ["97110", -1, false],
    ["97110", 481, false], ["97140", 1.5, false], ["97112", NaN, false],
    ["97161", 0, true], ["97161", 481, true], ["G0283", 0, true], ["99999", 15, false],
  ])("procedure %s at %s minutes: valid=%s", (cptCode, minutes, valid) => {
    expect(EncounterIngestSchema.safeParse({ ...example, minuteLines: [{ cptCode, minutes }] }).success).toBe(valid);
  });
  it.each([
    { ...example, renderingProviderNpi: "1234567890" },
    { ...example, patient: { ...example.patient, externalId: "REAL-123" } },
    { ...example, patient: { ...example.patient, name: "SYN" } },
    { ...example, patient: { ...example.patient, coverage: { ...example.patient.coverage, memberId: "12345" } } },
    { ...example, patient: { ...example.patient, coverage: { ...example.patient.coverage, payerCode: "UNKNOWN" } } },
    { ...example, planOfCare: { signedDate: "2026-09-25", certifyingNpi: "1234567890" } },
    { ...example, diagnoses: ["NOT-ICD10"] },
    { ...example, dateOfService: "2026-02-30" },
    { ...example, authorizationId: "not-a-uuid" },
    { ...example, organizationId: "00000000-0000-4000-8000-000000000001" },
  ])("rejects invalid or caller-supplied tenant data %#", (input) => {
    expect(EncounterIngestSchema.safeParse(input).success).toBe(false);
  });
  it("allows incomplete drafts and optional administrative references", () => {
    expect(EncounterIngestSchema.parse({ ...example, diagnoses: [], minuteLines: [], planOfCare: undefined }).planOfCare).toBeUndefined();
  });
  it("preserves unknown coverage metadata and POC expiry as null", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(CoverageSchema.parse({ id, patientId: id, payerId: id, memberId: "SYN-1", groupNumber: null, planName: null, subscriberRelationship: "SELF", active: true }).planName).toBeNull();
    expect(PlanOfCareSchema.parse({ id, patientId: id, signedDate: "2026-09-25", certifyingNpi: "0000000004", expiresOn: null }).expiresOn).toBeNull();
  });
});
