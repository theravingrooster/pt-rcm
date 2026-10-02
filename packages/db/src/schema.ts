import { sql } from "drizzle-orm";
import {
  boolean, check, customType, date, foreignKey, index, integer, jsonb,
  pgEnum, pgTable, text, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import {
  ClaimStatusSchema, EncounterStatusSchema, PatientSexSchema, PayerTypeSchema,
  ProviderRoleSchema, RuleOutcomeSchema, RuleSetStatusSchema,
  SubscriberRelationshipSchema, TaskOwnerSchema, TaskStatusSchema,
  type Address, type JsonObject,
} from "@pt-rcm/domain";

export const providerRole = pgEnum("provider_role", ProviderRoleSchema.options);
export const patientSex = pgEnum("patient_sex", PatientSexSchema.options);
export const subscriberRelationship = pgEnum("subscriber_relationship", SubscriberRelationshipSchema.options);
export const payerType = pgEnum("payer_type", PayerTypeSchema.options);
export const encounterStatus = pgEnum("encounter_status", EncounterStatusSchema.options);
export const claimStatus = pgEnum("claim_status", ClaimStatusSchema.options);
export const ruleSetStatus = pgEnum("rule_set_status", RuleSetStatusSchema.options);
export const ruleOutcome = pgEnum("rule_outcome", RuleOutcomeSchema.options);
export const taskOwner = pgEnum("task_owner", TaskOwnerSchema.options);
export const taskStatus = pgEnum("task_status", TaskStatusSchema.options);

// Normalize database timestamps to the domain's UTC ISO strings.
const utcTimestamp = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamp(3) with time zone",
  fromDriver: (value) => new Date(value).toISOString(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  billingNpi: text("billing_npi").notNull(),
  taxId: text("tax_id").notNull(),
  taxonomyCode: text("taxonomy_code").notNull(),
  address: jsonb("address").$type<Address>().notNull(),
}, (t) => [
  check("organizations_synthetic_npi", sql`${t.billingNpi} ~ '^000[0-9]{7}$'`),
  check("organizations_synthetic_tax_id", sql`${t.taxId} ~ '^SYN-TAX-[A-Za-z0-9-]+$'`),
  check("organizations_taxonomy", sql`${t.taxonomyCode} ~ '^[A-Z0-9]{10}$'`),
  check("organizations_address_object", sql`jsonb_typeof(${t.address}) = 'object'`),
]);

export const serviceFacilities = pgTable("service_facilities", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  npi: text("npi").notNull(),
  placeOfServiceCode: text("place_of_service_code").notNull().default("11"),
  address: jsonb("address").$type<Address>().notNull(),
}, (t) => [
  unique("service_facilities_id_org_unique").on(t.id, t.organizationId),
  index("service_facilities_org_idx").on(t.organizationId),
  check("service_facilities_synthetic_npi", sql`${t.npi} ~ '^000[0-9]{7}$'`),
  check("service_facilities_pos", sql`${t.placeOfServiceCode} ~ '^[0-9]{2}$'`),
  check("service_facilities_address_object", sql`jsonb_typeof(${t.address}) = 'object'`),
]);

export const providers = pgTable("providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  npi: text("npi").notNull(),
  taxonomyCode: text("taxonomy_code").notNull(),
  role: providerRole("role").notNull(),
}, (t) => [
  unique("providers_id_org_unique").on(t.id, t.organizationId),
  unique("providers_org_npi_role_unique").on(t.organizationId, t.npi, t.role),
  check("providers_synthetic_npi", sql`${t.npi} ~ '^000[0-9]{7}$'`),
  check("providers_taxonomy", sql`${t.taxonomyCode} ~ '^[A-Z0-9]{10}$'`),
]);

export const patients = pgTable("patients", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  externalId: text("external_id").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  dob: date("dob", { mode: "string" }).notNull(),
  sex: patientSex("sex").notNull(),
  address: jsonb("address").$type<Address>().notNull(),
}, (t) => [
  unique("patients_org_external_id_unique").on(t.organizationId, t.externalId),
  unique("patients_id_org_unique").on(t.id, t.organizationId),
  check("patients_address_object", sql`jsonb_typeof(${t.address}) = 'object'`),
]);

export const payers = pgTable("payers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  payerType: payerType("payer_type").notNull(),
  stediPayerId: text("stedi_payer_id"),
  requiresGpModifier: boolean("requires_gp_modifier").notNull(),
});

export const coverages = pgTable("coverages", {
  id: uuid("id").defaultRandom().primaryKey(),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  payerId: uuid("payer_id").notNull().references(() => payers.id),
  memberId: text("member_id").notNull(),
  groupNumber: text("group_number"),
  subscriberRelationship: subscriberRelationship("subscriber_relationship").notNull(),
  planName: text("plan_name"),
  active: boolean("active").notNull(),
  eligible: boolean("eligible"),
  checkedAt: utcTimestamp("checked_at"),
  deductibleRemainingCents: integer("deductible_remaining_cents"),
  planActive: boolean("plan_active"),
}, (t) => [
  unique("coverages_patient_payer_unique").on(t.patientId, t.payerId),
  index("coverages_patient_idx").on(t.patientId),
  index("coverages_payer_idx").on(t.payerId),
  check("coverages_synthetic_member_id", sql`${t.memberId} ~ '^SYN[A-Za-z0-9-]+$'`),
  check("coverages_deductible_nonnegative", sql`${t.deductibleRemainingCents} IS NULL OR ${t.deductibleRemainingCents} >= 0`),
]);

export const encounters = pgTable("encounters", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  externalId: text("external_id").notNull(),
  patientId: uuid("patient_id").notNull(),
  renderingProviderId: uuid("rendering_provider_id").notNull(),
  facilityId: uuid("facility_id").notNull(),
  dateOfService: date("date_of_service", { mode: "string" }).notNull(),
  status: encounterStatus("status").notNull(),
  authorizationId: uuid("authorization_id").references(() => authorizations.id),
}, (t) => [
  unique("encounters_org_external_id_unique").on(t.organizationId, t.externalId),
  foreignKey({ name: "encounters_patient_org_fk", columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
  foreignKey({ name: "encounters_provider_org_fk", columns: [t.renderingProviderId, t.organizationId], foreignColumns: [providers.id, providers.organizationId] }),
  foreignKey({ name: "encounters_facility_org_fk", columns: [t.facilityId, t.organizationId], foreignColumns: [serviceFacilities.id, serviceFacilities.organizationId] }),
  index("encounters_patient_idx").on(t.patientId),
  index("encounters_provider_idx").on(t.renderingProviderId),
  index("encounters_facility_idx").on(t.facilityId),
]);

export const encounterMinuteLines = pgTable("encounter_minute_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  encounterId: uuid("encounter_id").notNull().references(() => encounters.id),
  cptCode: text("cpt_code").notNull(),
  minutes: integer("minutes").notNull(),
  timed: boolean("timed").notNull(),
  notes: text("notes"),
}, (t) => [
  index("encounter_minute_lines_encounter_idx").on(t.encounterId),
  check("encounter_minute_lines_minutes", sql`${t.minutes} >= 0`),
  check("encounter_minute_lines_cpt", sql`${t.cptCode} ~ '^([0-9]{4}[0-9A-Z]|[A-Z][0-9]{4})$'`),
]);

export const diagnoses = pgTable("diagnoses", {
  id: uuid("id").defaultRandom().primaryKey(),
  encounterId: uuid("encounter_id").notNull().references(() => encounters.id),
  icd10: text("icd10").notNull(),
  pointer: integer("pointer").notNull(),
  primary: boolean("primary").notNull(),
}, (t) => [
  unique("diagnoses_encounter_pointer_unique").on(t.encounterId, t.pointer),
  uniqueIndex("diagnoses_one_primary_per_encounter").on(t.encounterId).where(sql`${t.primary}`),
  check("diagnoses_pointer", sql`${t.pointer} >= 0`),
  check("diagnoses_icd10", sql`${t.icd10} ~ '^[A-Z][0-9][A-Z0-9]([.][A-Z0-9]{1,4})?$'`),
]);

export const authorizations = pgTable("authorizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  payerId: uuid("payer_id").notNull().references(() => payers.id),
  cptFamily: text("cpt_family").notNull(),
  visitsAuthorized: integer("visits_authorized").notNull(),
  visitsUsed: integer("visits_used").notNull(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }).notNull(),
}, (t) => [
  index("authorizations_patient_payer_idx").on(t.patientId, t.payerId),
  index("authorizations_payer_idx").on(t.payerId),
  check("authorizations_visits", sql`${t.visitsAuthorized} >= 0 AND ${t.visitsUsed} >= 0`),
  check("authorizations_date_order", sql`${t.endDate} >= ${t.startDate}`),
]);

export const plansOfCare = pgTable("plans_of_care", {
  id: uuid("id").defaultRandom().primaryKey(),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  signedDate: date("signed_date", { mode: "string" }).notNull(),
  certifyingNpi: text("certifying_npi").notNull(),
  expiresOn: date("expires_on", { mode: "string" }),
}, (t) => [
  index("plans_of_care_patient_idx").on(t.patientId),
  check("plans_of_care_synthetic_npi", sql`${t.certifyingNpi} ~ '^000[0-9]{7}$'`),
  check("plans_of_care_date_order", sql`${t.expiresOn} >= ${t.signedDate}`),
]);

export const claims = pgTable("claims", {
  id: uuid("id").defaultRandom().primaryKey(),
  encounterId: uuid("encounter_id").notNull().references(() => encounters.id),
  version: integer("version").notNull(),
  status: claimStatus("status").notNull(),
  payerId: uuid("payer_id").notNull().references(() => payers.id),
  totalChargeCents: integer("total_charge_cents").notNull(),
  snapshotJson: jsonb("snapshot_json").$type<JsonObject>().notNull(),
}, (t) => [
  unique("claims_encounter_version_unique").on(t.encounterId, t.version),
  index("claims_payer_idx").on(t.payerId),
  check("claims_version", sql`${t.version} >= 1`),
  check("claims_charge", sql`${t.totalChargeCents} >= 0`),
  check("claims_snapshot_object", sql`jsonb_typeof(${t.snapshotJson}) = 'object'`),
]);

export const claimLines = pgTable("claim_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  claimId: uuid("claim_id").notNull().references(() => claims.id),
  cptCode: text("cpt_code").notNull(),
  modifiers: text("modifiers").array().notNull(),
  units: integer("units").notNull(),
  chargeCents: integer("charge_cents").notNull(),
  diagnosisPointers: integer("diagnosis_pointers").array().notNull(),
  minutes: integer("minutes").notNull(),
}, (t) => [
  index("claim_lines_claim_idx").on(t.claimId),
  check("claim_lines_cpt", sql`${t.cptCode} ~ '^([0-9]{4}[0-9A-Z]|[A-Z][0-9]{4})$'`),
  check("claim_lines_amounts", sql`${t.units} >= 1 AND ${t.chargeCents} >= 0 AND ${t.minutes} >= 0`),
  check("claim_lines_pointers", sql`(cardinality(${t.diagnosisPointers}) = 0 OR array_ndims(${t.diagnosisPointers}) = 1) AND array_position(${t.diagnosisPointers}, NULL) IS NULL AND 0 <= ALL(${t.diagnosisPointers})`),
  check("claim_lines_modifiers", sql`(cardinality(${t.modifiers}) = 0 OR (array_ndims(${t.modifiers}) = 1 AND array_to_string(${t.modifiers}, ',') ~ '^[A-Z0-9]{2}(,[A-Z0-9]{2})*$')) AND array_position(${t.modifiers}, NULL) IS NULL`),
]);

export const ruleSets = pgTable("rule_sets", {
  id: uuid("id").defaultRandom().primaryKey(),
  version: text("version").notNull().unique(),
  status: ruleSetStatus("status").notNull(),
  notes: text("notes").notNull(),
  definitionJson: jsonb("definition_json").$type<JsonObject>().notNull().default({}),
}, (t) => [
  uniqueIndex("rule_sets_one_active").on(t.status).where(sql`${t.status} = 'ACTIVE'`),
  check("rule_sets_definition_object", sql`jsonb_typeof(${t.definitionJson}) = 'object'`),
]);

export const ruleFires = pgTable("rule_fires", {
  id: uuid("id").defaultRandom().primaryKey(),
  claimId: uuid("claim_id").notNull().references(() => claims.id),
  ruleSetId: uuid("rule_set_id").references(() => ruleSets.id),
  // Identifies a versioned pure rule, not a ruleset row.
  ruleId: text("rule_id").notNull(),
  ruleVersion: text("rule_version").notNull(),
  outcome: ruleOutcome("outcome").notNull(),
  shadow: boolean("shadow").notNull(),
  detailJson: jsonb("detail_json").$type<JsonObject>().notNull(),
  createdAt: utcTimestamp("created_at").notNull().default(sql`now()`),
}, (t) => [
  index("rule_fires_claim_idx").on(t.claimId),
  index("rule_fires_rule_set_claim_idx").on(t.ruleSetId, t.claimId),
  check("rule_fires_detail_object", sql`jsonb_typeof(${t.detailJson}) = 'object'`),
]);

export const remits = pgTable("remits", {
  id: uuid("id").defaultRandom().primaryKey(),
  claimId: uuid("claim_id").notNull().references(() => claims.id),
  payerIcn: text("payer_icn").notNull(),
  paidCents: integer("paid_cents").notNull(),
  patientResponsibilityCents: integer("patient_responsibility_cents").notNull(),
  receivedOn: date("received_on", { mode: "string" }).notNull(),
  adjustmentCents: integer("adjustment_cents").notNull().default(0),
  detailJson: jsonb("detail_json").$type<JsonObject>().notNull().default({}),
}, (t) => [
  index("remits_claim_idx").on(t.claimId),
  check("remits_amounts", sql`${t.paidCents} >= 0 AND ${t.patientResponsibilityCents} >= 0`),
  check("remits_adjustments", sql`${t.adjustmentCents} >= 0`),
  check("remits_detail_object", sql`jsonb_typeof(${t.detailJson}) = 'object'`),
]);

export const remitLines = pgTable("remit_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  remitId: uuid("remit_id").notNull().references(() => remits.id),
  claimLineId: uuid("claim_line_id").notNull().references(() => claimLines.id),
  paidCents: integer("paid_cents").notNull(),
  carc: text("carc"),
  rarc: text("rarc"),
  patientResponsibilityCents: integer("patient_responsibility_cents").notNull().default(0),
  adjustmentCents: integer("adjustment_cents").notNull().default(0),
  contractualWriteOffCents: integer("contractual_write_off_cents").notNull().default(0),
  detailJson: jsonb("detail_json").$type<JsonObject>().notNull().default({}),
}, (t) => [
  index("remit_lines_remit_idx").on(t.remitId),
  index("remit_lines_claim_line_idx").on(t.claimLineId),
  check("remit_lines_paid", sql`${t.paidCents} >= 0`),
  check("remit_lines_adjustments", sql`${t.patientResponsibilityCents} >= 0 AND ${t.adjustmentCents} >= 0 AND ${t.contractualWriteOffCents} >= 0 AND ${t.contractualWriteOffCents} <= ${t.adjustmentCents}`),
  check("remit_lines_detail_object", sql`jsonb_typeof(${t.detailJson}) = 'object'`),
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  claimId: uuid("claim_id").notNull().references(() => claims.id),
  kind: text("kind").notNull(),
  owner: taskOwner("owner").notNull(),
  status: taskStatus("status").notNull(),
  reason: text("reason").notNull(),
}, (t) => [index("tasks_claim_idx").on(t.claimId)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  // Polymorphic reference intentionally survives the lifetime of its entity.
  entityId: uuid("entity_id").notNull(),
  at: utcTimestamp("at").notNull().default(sql`now()`),
  detailJson: jsonb("detail_json").$type<JsonObject>().notNull(),
}, (t) => [
  index("audit_events_entity_idx").on(t.entity, t.entityId, t.at),
  check("audit_events_detail_object", sql`jsonb_typeof(${t.detailJson}) = 'object'`),
]);
