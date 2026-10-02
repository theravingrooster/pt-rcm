import { z } from "zod";

export const ProviderRoleSchema = z.enum(["RENDERING", "BILLING", "REFERRING"]);
export const ProviderRole = ProviderRoleSchema.enum;
export type ProviderRole = z.infer<typeof ProviderRoleSchema>;
// Administrative sex for professional billing: male, female, or unknown.
export const PatientSexSchema = z.enum(["M", "F", "U"]);
export const PatientSex = PatientSexSchema.enum;
export type PatientSex = z.infer<typeof PatientSexSchema>;
export const SubscriberRelationshipSchema = z.enum(["SELF", "SPOUSE", "CHILD", "OTHER"]);
export const SubscriberRelationship = SubscriberRelationshipSchema.enum;
export type SubscriberRelationship = z.infer<typeof SubscriberRelationshipSchema>;
export const PayerTypeSchema = z.enum(["MEDICARE", "COMMERCIAL"]);
export const PayerType = PayerTypeSchema.enum;
export type PayerType = z.infer<typeof PayerTypeSchema>;
export const EncounterStatusSchema = z.enum(["DRAFT", "READY", "HELD", "CLAIMED"]);
export const EncounterStatus = EncounterStatusSchema.enum;
export type EncounterStatus = z.infer<typeof EncounterStatusSchema>;
export const ClaimStatusSchema = z.enum([
  "DRAFT", "SCRUBBED", "BLOCKED", "SHADOWED", "SUBMITTED", "ACCEPTED",
  "REJECTED", "PAID", "DENIED", "PATIENT_BALANCE",
]);
export const ClaimStatus = ClaimStatusSchema.enum;
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export const RuleSetStatusSchema = z.enum(["DRAFT", "SHADOW", "ACTIVE", "RETIRED"]);
export const RuleSetStatus = RuleSetStatusSchema.enum;
export type RuleSetStatus = z.infer<typeof RuleSetStatusSchema>;
export const RuleOutcomeSchema = z.enum(["PASS", "FLAG", "DOWNGRADE", "BLOCK"]);
export const RuleOutcome = RuleOutcomeSchema.enum;
export type RuleOutcome = z.infer<typeof RuleOutcomeSchema>;
export const TaskOwnerSchema = z.enum(["OPERATOR", "CUSTOMER", "NONE"]);
export const TaskOwner = TaskOwnerSchema.enum;
export type TaskOwner = z.infer<typeof TaskOwnerSchema>;
export const TaskStatusSchema = z.enum(["OPEN", "DONE"]);
export const TaskStatus = TaskStatusSchema.enum;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const IdSchema = z.string().uuid();
const NonEmptyString = z.string().trim().min(1);
export const IsoDateSchema = z.string().date().regex(/^(?!0000)/, "Year must be positive");
export const UtcTimestampSchema = z.string().datetime({ offset: false });
export const NpiSchema = z.string().regex(/^000\d{7}$/, "Use a synthetic 10-digit NPI starting with 000");
export const TaxIdSchema = z.string().regex(/^SYN-TAX-[A-Za-z0-9-]+$/);
export const MemberIdSchema = z.string().regex(/^SYN[A-Za-z0-9-]+$/);
// Match PostgreSQL int4; monetary values are integer cents, never floating dollars.
export const NonNegativeIntSchema = z.number().int().min(0).max(2_147_483_647);
export const MoneyCentsSchema = NonNegativeIntSchema;
const PositiveIntSchema = NonNegativeIntSchema.min(1);
// Format validation only; this is not a licensed code catalog or a billing rule.
// The existing cptCode fields also carry HCPCS Level II codes such as G0283.
export const CptCodeSchema = z.string().regex(/^(?:\d{4}[0-9A-Z]|[A-Z]\d{4})$/);
export const Icd10Schema = z.string().regex(/^[A-Z][0-9][A-Z0-9](?:\.[A-Z0-9]{1,4})?$/);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonValueSchema), z.record(JsonValueSchema),
]));
export const JsonObjectSchema = z.record(JsonValueSchema);

export const AddressSchema = z.object({
  line1: NonEmptyString,
  line2: NonEmptyString.nullable(),
  city: NonEmptyString,
  state: z.string().regex(/^[A-Z]{2}$/),
  postalCode: z.string().regex(/^\d{5}(?:-\d{4})?$/),
  country: z.literal("US").default("US"),
}).strict();
export type Address = z.infer<typeof AddressSchema>;

export const OrganizationSchema = z.object({
  id: IdSchema, name: NonEmptyString, billingNpi: NpiSchema, taxId: TaxIdSchema,
  taxonomyCode: z.string().regex(/^[A-Z0-9]{10}$/), address: AddressSchema,
}).strict();
export type Organization = z.infer<typeof OrganizationSchema>;

export const ServiceFacilitySchema = z.object({
  id: IdSchema, organizationId: IdSchema, name: NonEmptyString, npi: NpiSchema,
  placeOfServiceCode: z.string().regex(/^\d{2}$/).default("11"), address: AddressSchema,
}).strict();
export type ServiceFacility = z.infer<typeof ServiceFacilitySchema>;

export const ProviderSchema = z.object({
  id: IdSchema, organizationId: IdSchema, firstName: NonEmptyString, lastName: NonEmptyString,
  npi: NpiSchema, taxonomyCode: z.string().regex(/^[A-Z0-9]{10}$/), role: ProviderRoleSchema,
}).strict();
export type Provider = z.infer<typeof ProviderSchema>;

export const PatientSchema = z.object({
  id: IdSchema, organizationId: IdSchema, externalId: NonEmptyString,
  firstName: NonEmptyString, lastName: NonEmptyString, dob: IsoDateSchema,
  sex: PatientSexSchema, address: AddressSchema,
}).strict();
export type Patient = z.infer<typeof PatientSchema>;

export const CoverageSchema = z.object({
  id: IdSchema, patientId: IdSchema, payerId: IdSchema, memberId: MemberIdSchema,
  groupNumber: NonEmptyString.nullable(), subscriberRelationship: SubscriberRelationshipSchema,
  planName: NonEmptyString.nullable(), active: z.boolean(),
}).strict();
export type Coverage = z.infer<typeof CoverageSchema>;

export const PayerSchema = z.object({
  id: IdSchema, name: NonEmptyString, payerType: PayerTypeSchema,
  stediPayerId: NonEmptyString.nullable(), requiresGpModifier: z.boolean(),
}).strict();
export type Payer = z.infer<typeof PayerSchema>;

export const EncounterSchema = z.object({
  id: IdSchema, organizationId: IdSchema, externalId: NonEmptyString, patientId: IdSchema,
  renderingProviderId: IdSchema, facilityId: IdSchema, dateOfService: IsoDateSchema,
  status: EncounterStatusSchema, authorizationId: IdSchema.nullable().default(null),
}).strict();
export type Encounter = z.infer<typeof EncounterSchema>;

export const EncounterMinuteLineSchema = z.object({
  id: IdSchema, encounterId: IdSchema, cptCode: CptCodeSchema,
  minutes: NonNegativeIntSchema, timed: z.boolean(), notes: z.string().nullable(),
}).strict();
export type EncounterMinuteLine = z.infer<typeof EncounterMinuteLineSchema>;

export const DiagnosisSchema = z.object({
  id: IdSchema, encounterId: IdSchema, icd10: Icd10Schema,
  pointer: NonNegativeIntSchema, primary: z.boolean(),
}).strict();
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const AuthorizationSchema = z.object({
  id: IdSchema, patientId: IdSchema, payerId: IdSchema, cptFamily: NonEmptyString,
  // Preserve overuse as recorded; future rules can flag it without rewriting history.
  visitsAuthorized: NonNegativeIntSchema, visitsUsed: NonNegativeIntSchema,
  startDate: IsoDateSchema, endDate: IsoDateSchema,
}).strict().refine((value) => value.endDate >= value.startDate, {
  message: "endDate must be on or after startDate", path: ["endDate"],
});
export type Authorization = z.infer<typeof AuthorizationSchema>;

export const PlanOfCareSchema = z.object({
  id: IdSchema, patientId: IdSchema, signedDate: IsoDateSchema,
  certifyingNpi: NpiSchema, expiresOn: IsoDateSchema.nullable(),
}).strict().refine((value) => value.expiresOn === null || value.expiresOn >= value.signedDate, {
  message: "expiresOn must be on or after signedDate", path: ["expiresOn"],
});
export type PlanOfCare = z.infer<typeof PlanOfCareSchema>;

export const ClaimSchema = z.object({
  id: IdSchema, encounterId: IdSchema, version: PositiveIntSchema, status: ClaimStatusSchema,
  payerId: IdSchema, totalChargeCents: MoneyCentsSchema, snapshotJson: JsonObjectSchema,
}).strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimLineSchema = z.object({
  id: IdSchema, claimId: IdSchema, cptCode: CptCodeSchema,
  modifiers: z.array(z.string().regex(/^[A-Z0-9]{2}$/)), units: PositiveIntSchema,
  chargeCents: MoneyCentsSchema, diagnosisPointers: z.array(NonNegativeIntSchema),
  minutes: NonNegativeIntSchema,
}).strict();
export type ClaimLine = z.infer<typeof ClaimLineSchema>;

export const RuleSetSchema = z.object({
  id: IdSchema, version: NonEmptyString, status: RuleSetStatusSchema, notes: z.string(),
  definitionJson: JsonObjectSchema.optional(),
}).strict();
export type RuleSet = z.infer<typeof RuleSetSchema>;

export const RuleFireSchema = z.object({
  id: IdSchema, claimId: IdSchema, ruleId: NonEmptyString, ruleVersion: NonEmptyString,
  ruleSetId: IdSchema.nullable().optional(),
  outcome: RuleOutcomeSchema, shadow: z.boolean(), detailJson: JsonObjectSchema,
  createdAt: UtcTimestampSchema,
}).strict();
export type RuleFire = z.infer<typeof RuleFireSchema>;

export const RemitSchema = z.object({
  id: IdSchema, claimId: IdSchema, payerIcn: NonEmptyString,
  paidCents: MoneyCentsSchema, patientResponsibilityCents: MoneyCentsSchema,
  receivedOn: IsoDateSchema,
  adjustmentCents: MoneyCentsSchema.default(0),
  // Raw envelope and posting result retain unmatched amounts and balance flags.
  detailJson: JsonObjectSchema.default({}),
}).strict();
export type Remit = z.infer<typeof RemitSchema>;

export const RemitLineSchema = z.object({
  id: IdSchema, remitId: IdSchema, claimLineId: IdSchema,
  paidCents: MoneyCentsSchema, carc: NonEmptyString.nullable(), rarc: NonEmptyString.nullable(),
  patientResponsibilityCents: MoneyCentsSchema.default(0), adjustmentCents: MoneyCentsSchema.default(0),
  contractualWriteOffCents: MoneyCentsSchema.default(0), detailJson: JsonObjectSchema.default({}),
}).strict();
export type RemitLine = z.infer<typeof RemitLineSchema>;

export const TaskSchema = z.object({
  id: IdSchema, claimId: IdSchema, kind: NonEmptyString, owner: TaskOwnerSchema,
  status: TaskStatusSchema, reason: NonEmptyString,
}).strict();
export type Task = z.infer<typeof TaskSchema>;

export const AuditEventSchema = z.object({
  id: IdSchema, actor: NonEmptyString, action: NonEmptyString, entity: NonEmptyString,
  entityId: IdSchema, at: UtcTimestampSchema, detailJson: JsonObjectSchema,
}).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;
