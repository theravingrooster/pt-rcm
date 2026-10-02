CREATE TYPE "public"."claim_status" AS ENUM('DRAFT', 'SCRUBBED', 'BLOCKED', 'SHADOWED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'PAID', 'DENIED', 'PATIENT_BALANCE');--> statement-breakpoint
CREATE TYPE "public"."encounter_status" AS ENUM('DRAFT', 'READY', 'HELD', 'CLAIMED');--> statement-breakpoint
CREATE TYPE "public"."patient_sex" AS ENUM('M', 'F', 'U');--> statement-breakpoint
CREATE TYPE "public"."payer_type" AS ENUM('MEDICARE', 'COMMERCIAL');--> statement-breakpoint
CREATE TYPE "public"."provider_role" AS ENUM('RENDERING', 'BILLING', 'REFERRING');--> statement-breakpoint
CREATE TYPE "public"."rule_outcome" AS ENUM('PASS', 'FLAG', 'DOWNGRADE', 'BLOCK');--> statement-breakpoint
CREATE TYPE "public"."rule_set_status" AS ENUM('DRAFT', 'SHADOW', 'ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."subscriber_relationship" AS ENUM('SELF', 'SPOUSE', 'CHILD', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."task_owner" AS ENUM('OPERATOR', 'CUSTOMER', 'NONE');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('OPEN', 'DONE');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"detail_json" jsonb NOT NULL,
	CONSTRAINT "audit_events_detail_object" CHECK (jsonb_typeof("audit_events"."detail_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"cpt_family" text NOT NULL,
	"visits_authorized" integer NOT NULL,
	"visits_used" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	CONSTRAINT "authorizations_visits" CHECK ("authorizations"."visits_authorized" >= 0 AND "authorizations"."visits_used" >= 0),
	CONSTRAINT "authorizations_date_order" CHECK ("authorizations"."end_date" >= "authorizations"."start_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"cpt_code" text NOT NULL,
	"modifiers" text[] NOT NULL,
	"units" integer NOT NULL,
	"charge_cents" integer NOT NULL,
	"diagnosis_pointers" integer[] NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "claim_lines_cpt" CHECK ("claim_lines"."cpt_code" ~ '^[0-9]{4}[0-9A-Z]$'),
	CONSTRAINT "claim_lines_amounts" CHECK ("claim_lines"."units" >= 1 AND "claim_lines"."charge_cents" >= 0 AND "claim_lines"."minutes" >= 0),
	CONSTRAINT "claim_lines_pointers" CHECK ((cardinality("claim_lines"."diagnosis_pointers") = 0 OR array_ndims("claim_lines"."diagnosis_pointers") = 1) AND array_position("claim_lines"."diagnosis_pointers", NULL) IS NULL AND 0 <= ALL("claim_lines"."diagnosis_pointers")),
	CONSTRAINT "claim_lines_modifiers" CHECK ((cardinality("claim_lines"."modifiers") = 0 OR (array_ndims("claim_lines"."modifiers") = 1 AND array_to_string("claim_lines"."modifiers", ',') ~ '^[A-Z0-9]{2}(,[A-Z0-9]{2})*$')) AND array_position("claim_lines"."modifiers", NULL) IS NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"encounter_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "claim_status" NOT NULL,
	"payer_id" uuid NOT NULL,
	"total_charge_cents" integer NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	CONSTRAINT "claims_encounter_version_unique" UNIQUE("encounter_id","version"),
	CONSTRAINT "claims_version" CHECK ("claims"."version" >= 1),
	CONSTRAINT "claims_charge" CHECK ("claims"."total_charge_cents" >= 0),
	CONSTRAINT "claims_snapshot_object" CHECK (jsonb_typeof("claims"."snapshot_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coverages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"member_id" text NOT NULL,
	"group_number" text NOT NULL,
	"subscriber_relationship" "subscriber_relationship" NOT NULL,
	"plan_name" text NOT NULL,
	"active" boolean NOT NULL,
	CONSTRAINT "coverages_synthetic_member_id" CHECK ("coverages"."member_id" ~ '^SYN[A-Za-z0-9-]+$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "diagnoses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"encounter_id" uuid NOT NULL,
	"icd10" text NOT NULL,
	"pointer" integer NOT NULL,
	"primary" boolean NOT NULL,
	CONSTRAINT "diagnoses_encounter_pointer_unique" UNIQUE("encounter_id","pointer"),
	CONSTRAINT "diagnoses_pointer" CHECK ("diagnoses"."pointer" >= 0),
	CONSTRAINT "diagnoses_icd10" CHECK ("diagnoses"."icd10" ~ '^[A-Z][0-9][A-Z0-9]([.][A-Z0-9]{1,4})?$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "encounter_minute_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"encounter_id" uuid NOT NULL,
	"cpt_code" text NOT NULL,
	"minutes" integer NOT NULL,
	"timed" boolean NOT NULL,
	"notes" text,
	CONSTRAINT "encounter_minute_lines_minutes" CHECK ("encounter_minute_lines"."minutes" >= 0),
	CONSTRAINT "encounter_minute_lines_cpt" CHECK ("encounter_minute_lines"."cpt_code" ~ '^[0-9]{4}[0-9A-Z]$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "encounters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"rendering_provider_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"date_of_service" date NOT NULL,
	"status" "encounter_status" NOT NULL,
	CONSTRAINT "encounters_org_external_id_unique" UNIQUE("organization_id","external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"billing_npi" text NOT NULL,
	"tax_id" text NOT NULL,
	"taxonomy_code" text NOT NULL,
	"address" jsonb NOT NULL,
	CONSTRAINT "organizations_synthetic_npi" CHECK ("organizations"."billing_npi" ~ '^000[0-9]{7}$'),
	CONSTRAINT "organizations_synthetic_tax_id" CHECK ("organizations"."tax_id" ~ '^SYN-TAX-[A-Za-z0-9-]+$'),
	CONSTRAINT "organizations_taxonomy" CHECK ("organizations"."taxonomy_code" ~ '^[A-Z0-9]{10}$'),
	CONSTRAINT "organizations_address_object" CHECK (jsonb_typeof("organizations"."address") = 'object')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"dob" date NOT NULL,
	"sex" "patient_sex" NOT NULL,
	"address" jsonb NOT NULL,
	CONSTRAINT "patients_org_external_id_unique" UNIQUE("organization_id","external_id"),
	CONSTRAINT "patients_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "patients_address_object" CHECK (jsonb_typeof("patients"."address") = 'object')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"payer_type" "payer_type" NOT NULL,
	"stedi_payer_id" text,
	"requires_gp_modifier" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans_of_care" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"signed_date" date NOT NULL,
	"certifying_npi" text NOT NULL,
	"expires_on" date NOT NULL,
	CONSTRAINT "plans_of_care_synthetic_npi" CHECK ("plans_of_care"."certifying_npi" ~ '^000[0-9]{7}$'),
	CONSTRAINT "plans_of_care_date_order" CHECK ("plans_of_care"."expires_on" >= "plans_of_care"."signed_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"npi" text NOT NULL,
	"taxonomy_code" text NOT NULL,
	"role" "provider_role" NOT NULL,
	CONSTRAINT "providers_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "providers_org_npi_role_unique" UNIQUE("organization_id","npi","role"),
	CONSTRAINT "providers_synthetic_npi" CHECK ("providers"."npi" ~ '^000[0-9]{7}$'),
	CONSTRAINT "providers_taxonomy" CHECK ("providers"."taxonomy_code" ~ '^[A-Z0-9]{10}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remit_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remit_id" uuid NOT NULL,
	"claim_line_id" uuid NOT NULL,
	"paid_cents" integer NOT NULL,
	"carc" text NOT NULL,
	"rarc" text,
	CONSTRAINT "remit_lines_paid" CHECK ("remit_lines"."paid_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"payer_icn" text NOT NULL,
	"paid_cents" integer NOT NULL,
	"patient_responsibility_cents" integer NOT NULL,
	"received_on" date NOT NULL,
	CONSTRAINT "remits_amounts" CHECK ("remits"."paid_cents" >= 0 AND "remits"."patient_responsibility_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rule_fires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"outcome" "rule_outcome" NOT NULL,
	"shadow" boolean NOT NULL,
	"detail_json" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_fires_detail_object" CHECK (jsonb_typeof("rule_fires"."detail_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"status" "rule_set_status" NOT NULL,
	"notes" text NOT NULL,
	CONSTRAINT "rule_sets_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"npi" text NOT NULL,
	"place_of_service_code" text DEFAULT '11' NOT NULL,
	"address" jsonb NOT NULL,
	CONSTRAINT "service_facilities_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "service_facilities_synthetic_npi" CHECK ("service_facilities"."npi" ~ '^000[0-9]{7}$'),
	CONSTRAINT "service_facilities_pos" CHECK ("service_facilities"."place_of_service_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "service_facilities_address_object" CHECK (jsonb_typeof("service_facilities"."address") = 'object')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"owner" "task_owner" NOT NULL,
	"status" "task_status" NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claims" ADD CONSTRAINT "claims_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claims" ADD CONSTRAINT "claims_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coverages" ADD CONSTRAINT "coverages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coverages" ADD CONSTRAINT "coverages_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "encounter_minute_lines" ADD CONSTRAINT "encounter_minute_lines_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "encounters" ADD CONSTRAINT "encounters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_org_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "encounters" ADD CONSTRAINT "encounters_provider_org_fk" FOREIGN KEY ("rendering_provider_id","organization_id") REFERENCES "public"."providers"("id","organization_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "encounters" ADD CONSTRAINT "encounters_facility_org_fk" FOREIGN KEY ("facility_id","organization_id") REFERENCES "public"."service_facilities"("id","organization_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "patients" ADD CONSTRAINT "patients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plans_of_care" ADD CONSTRAINT "plans_of_care_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "providers" ADD CONSTRAINT "providers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "remit_lines" ADD CONSTRAINT "remit_lines_remit_id_remits_id_fk" FOREIGN KEY ("remit_id") REFERENCES "public"."remits"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "remit_lines" ADD CONSTRAINT "remit_lines_claim_line_id_claim_lines_id_fk" FOREIGN KEY ("claim_line_id") REFERENCES "public"."claim_lines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "remits" ADD CONSTRAINT "remits_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_fires" ADD CONSTRAINT "rule_fires_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_facilities" ADD CONSTRAINT "service_facilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_entity_idx" ON "audit_events" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authorizations_patient_payer_idx" ON "authorizations" USING btree ("patient_id","payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authorizations_payer_idx" ON "authorizations" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_lines_claim_idx" ON "claim_lines" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_payer_idx" ON "claims" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coverages_patient_idx" ON "coverages" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coverages_payer_idx" ON "coverages" USING btree ("payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "diagnoses_one_primary_per_encounter" ON "diagnoses" USING btree ("encounter_id") WHERE "diagnoses"."primary";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "encounter_minute_lines_encounter_idx" ON "encounter_minute_lines" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "encounters_patient_idx" ON "encounters" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "encounters_provider_idx" ON "encounters" USING btree ("rendering_provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "encounters_facility_idx" ON "encounters" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plans_of_care_patient_idx" ON "plans_of_care" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remit_lines_remit_idx" ON "remit_lines" USING btree ("remit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remit_lines_claim_line_idx" ON "remit_lines" USING btree ("claim_line_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remits_claim_idx" ON "remits" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_fires_claim_idx" ON "rule_fires" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_facilities_org_idx" ON "service_facilities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_claim_idx" ON "tasks" USING btree ("claim_id");