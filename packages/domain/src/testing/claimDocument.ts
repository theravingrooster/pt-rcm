import { allocateUnits } from "../eightMinute.js";
import { fixtureLineChargeCents, loadMedicareMinuteLadder } from "../fixtures/index.js";
import type { ClaimDocumentInput } from "../claimDocument.js";

// Test-only synthetic source records. Not exported by the package's public API.
export function makeClaimDocumentInput(): ClaimDocumentInput {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const address = { line1: "1 SYN Test Way", line2: null, city: "SYN City", state: "CA", postalCode: "00000", country: "US" as const };
  const organization = { id: id(1), name: "SYN Ortho PT", billingNpi: "0000000001", taxId: "SYN-TAX-1", taxonomyCode: "225100000X", address };
  const patient = { id: id(10), organizationId: organization.id, externalId: "SYN-PATIENT-DOCUMENT", firstName: "SYN", lastName: "Shoulder Demo", dob: "2000-01-01", sex: "U" as const, address };
  const payer = { id: id(5), name: "Medicare", payerType: "MEDICARE" as const, stediPayerId: null, requiresGpModifier: true };
  const encounter = { id: id(11), organizationId: organization.id, externalId: "SYN-ENCOUNTER-DOCUMENT", patientId: patient.id,
    renderingProviderId: id(3), facilityId: id(2), dateOfService: "2026-10-01", status: "DRAFT" as const, authorizationId: null };
  // CPT is AMA-licensed. This is a local test fixture, not the CPT data file.
  const allocation = allocateUnits([{ cptCode: "97110", minutes: 20, timed: true }, { cptCode: "97530", minutes: 20, timed: true }], loadMedicareMinuteLadder());
  const claimLines = allocation.lines.map((line, index) => ({ id: id(30 + index), claimId: id(20), cptCode: line.cptCode, minutes: line.minutes,
    units: line.units, modifiers: ["GP"], chargeCents: fixtureLineChargeCents(line.cptCode, line.units), diagnosisPointers: [0] }));
  return {
    claim: { id: id(20), encounterId: encounter.id, payerId: payer.id, status: "SCRUBBED", version: 1, totalChargeCents: 13500, snapshotJson: {} },
    claimLines, organization, patient, payer, encounter,
    coverage: { id: id(12), patientId: patient.id, payerId: payer.id, memberId: "SYN-MEMBER-DOCUMENT", groupNumber: null, subscriberRelationship: "SELF", planName: null, active: true },
    renderingProvider: { id: id(3), organizationId: organization.id, firstName: "SYN", lastName: "Renderer", npi: "0000000003", taxonomyCode: "225100000X", role: "RENDERING" },
    serviceFacility: { id: id(2), organizationId: organization.id, name: "SYN PT Office", npi: "0000000002", placeOfServiceCode: "11", address },
    diagnoses: [{ id: id(13), encounterId: encounter.id, icd10: "M25.511", pointer: 0, primary: true }],
  };
}
