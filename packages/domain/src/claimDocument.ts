import { z } from "zod";
import {
  ClaimLineSchema, ClaimSchema, CoverageSchema, DiagnosisSchema, EncounterSchema,
  IdSchema, IsoDateSchema, MoneyCentsSchema, NpiSchema, OrganizationSchema,
  PatientSchema, PayerSchema, ProviderSchema, ServiceFacilitySchema, TaxIdSchema,
  type ClaimStatus,
} from "./models.js";

const PersonSchema = PatientSchema.pick({ firstName: true, lastName: true, dob: true, sex: true, address: true });
export const ClaimDocumentLineSchema = ClaimLineSchema.pick({
  cptCode: true, modifiers: true, units: true, chargeCents: true, diagnosisPointers: true,
});

/** Internal JSON only. This schema does not establish 837P completeness or validity. */
export const ClaimDocumentSchema = z.object({
  claimId: IdSchema,
  claimVersion: ClaimSchema.shape.version,
  submitter: OrganizationSchema.pick({ id: true, name: true }),
  receiver: PayerSchema.pick({ id: true, name: true, payerType: true, stediPayerId: true }),
  billingProvider: z.object({
    name: OrganizationSchema.shape.name, npi: NpiSchema, tin: TaxIdSchema,
    taxonomyCode: OrganizationSchema.shape.taxonomyCode, address: OrganizationSchema.shape.address,
  }).strict(),
  renderingProvider: z.object({ npi: NpiSchema }).strict(),
  serviceFacility: ServiceFacilitySchema.pick({ id: true, name: true, npi: true, address: true }),
  placeOfServiceCode: ServiceFacilitySchema.shape.placeOfServiceCode,
  subscriber: z.object({
    memberId: CoverageSchema.shape.memberId,
    relationship: CoverageSchema.shape.subscriberRelationship,
    groupNumber: CoverageSchema.shape.groupNumber,
    planName: CoverageSchema.shape.planName,
    // Coverage has no separate subscriber demographics. Non-SELF stays null;
    // a later mapping must collect that information, never assume the patient.
    person: PersonSchema.nullable(),
  }).strict(),
  patient: PatientSchema.omit({ organizationId: true }),
  claimControlNumber: z.string().regex(/^SYN[A-F0-9]{12}$/),
  dateOfService: IsoDateSchema,
  // Preserve internal zero-based pointers. A future X12 mapper owns conversion.
  diagnoses: z.array(DiagnosisSchema.pick({ icd10: true, pointer: true, primary: true })),
  lines: z.array(ClaimDocumentLineSchema),
  totalChargeCents: MoneyCentsSchema,
  benefitsAssigned: z.boolean().default(true),
  acceptAssignment: z.boolean().default(true),
}).strict().superRefine((doc, ctx) => {
  if (doc.lines.reduce((sum, line) => sum + line.chargeCents, 0) !== doc.totalChargeCents) {
    ctx.addIssue({ code: "custom", path: ["totalChargeCents"], message: "Total must equal the saved line charges" });
  }
  const pointers = new Set(doc.diagnoses.map((diagnosis) => diagnosis.pointer));
  if (pointers.size !== doc.diagnoses.length) {
    ctx.addIssue({ code: "custom", path: ["diagnoses"], message: "Diagnosis pointers must be unique" });
  }
  doc.lines.forEach((line, index) => {
    if (line.diagnosisPointers.some((pointer) => !pointers.has(pointer))) {
      ctx.addIssue({ code: "custom", path: ["lines", index, "diagnosisPointers"], message: "Every pointer must reference a recorded diagnosis" });
    }
  });
});
export type ClaimDocument = z.infer<typeof ClaimDocumentSchema>;

export const ClaimDocumentInputSchema = z.object({
  claim: ClaimSchema, claimLines: z.array(ClaimLineSchema), organization: OrganizationSchema,
  renderingProvider: ProviderSchema, serviceFacility: ServiceFacilitySchema,
  patient: PatientSchema, coverage: CoverageSchema, payer: PayerSchema,
  encounter: EncounterSchema, diagnoses: z.array(DiagnosisSchema),
  benefitsAssigned: z.boolean().optional(), acceptAssignment: z.boolean().optional(),
}).strict().superRefine((source, ctx) => {
  const { claim, encounter, organization, patient, coverage, payer, renderingProvider, serviceFacility } = source;
  const consistent = claim.encounterId === encounter.id && claim.payerId === payer.id
    && encounter.organizationId === organization.id && patient.organizationId === organization.id
    && renderingProvider.organizationId === organization.id && serviceFacility.organizationId === organization.id
    && encounter.patientId === patient.id && encounter.renderingProviderId === renderingProvider.id
    && encounter.facilityId === serviceFacility.id && renderingProvider.role === "RENDERING"
    && coverage.patientId === patient.id && coverage.payerId === payer.id
    && source.claimLines.every((line) => line.claimId === claim.id)
    && source.diagnoses.every((diagnosis) => diagnosis.encounterId === encounter.id)
    && new Set(source.claimLines.map((line) => line.id)).size === source.claimLines.length;
  if (!consistent) ctx.addIssue({ code: "custom", message: "Claim document sources must belong to the same claim, encounter, organization, patient and payer" });
});
export type ClaimDocumentInput = z.input<typeof ClaimDocumentInputSchema>;

export class ClaimNotSubmittable extends Error {
  readonly code = "CLAIM_NOT_SUBMITTABLE";
  constructor(readonly status: ClaimStatus) {
    super(`Claim status ${status} cannot build a document; SCRUBBED is required`);
    this.name = "ClaimNotSubmittable";
  }
}

/** Pure projection of a scrubbed claim. Never allocate, reprice, rerun rules, or submit. */
export function buildClaimDocument(input: ClaimDocumentInput): ClaimDocument {
  const claim = ClaimSchema.parse(input.claim);
  // Shadow findings are not an active scrub. Require affirmative SCRUBBED status.
  if (claim.status !== "SCRUBBED") throw new ClaimNotSubmittable(claim.status);
  const source = ClaimDocumentInputSchema.parse(input);
  const { organization, coverage, patient } = source;
  return ClaimDocumentSchema.parse({
    claimId: claim.id, claimVersion: claim.version,
    submitter: { id: organization.id, name: organization.name },
    receiver: { id: source.payer.id, name: source.payer.name, payerType: source.payer.payerType, stediPayerId: source.payer.stediPayerId },
    billingProvider: { name: organization.name, npi: organization.billingNpi, tin: organization.taxId, taxonomyCode: organization.taxonomyCode, address: organization.address },
    renderingProvider: { npi: source.renderingProvider.npi },
    serviceFacility: { id: source.serviceFacility.id, name: source.serviceFacility.name, npi: source.serviceFacility.npi, address: source.serviceFacility.address },
    placeOfServiceCode: source.serviceFacility.placeOfServiceCode,
    subscriber: { memberId: coverage.memberId, relationship: coverage.subscriberRelationship, groupNumber: coverage.groupNumber, planName: coverage.planName,
      person: coverage.subscriberRelationship === "SELF" ? PersonSchema.parse({ firstName: patient.firstName, lastName: patient.lastName, dob: patient.dob, sex: patient.sex, address: patient.address }) : null },
    patient: { id: patient.id, externalId: patient.externalId, firstName: patient.firstName, lastName: patient.lastName, dob: patient.dob, sex: patient.sex, address: patient.address },
    // Stable fixture control number, not an interchange or clearinghouse identifier.
    claimControlNumber: `SYN${claim.id.replaceAll("-", "").slice(-12).toUpperCase()}`,
    dateOfService: source.encounter.dateOfService,
    diagnoses: source.diagnoses.map(({ icd10, pointer, primary }) => ({ icd10, pointer, primary })).sort((a, b) => a.pointer - b.pointer),
    lines: source.claimLines.map(({ cptCode, modifiers, units, chargeCents, diagnosisPointers }) => ({ cptCode, modifiers, units, chargeCents, diagnosisPointers })),
    totalChargeCents: claim.totalChargeCents,
    benefitsAssigned: source.benefitsAssigned, acceptAssignment: source.acceptAssignment,
  });
}

export function renderClaimDocumentJson(document: ClaimDocument): string {
  return `${JSON.stringify(ClaimDocumentSchema.parse(document), null, 2)}\n`;
}
