CREATE TABLE IF NOT EXISTS "patient_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claim_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"recorded_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_payments_amount_positive" CHECK ("patient_payments"."amount_cents" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "patient_payments" ADD CONSTRAINT "patient_payments_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_payments_claim_idx" ON "patient_payments" USING btree ("claim_id");--> statement-breakpoint
-- Keep the new ledger under the same Supabase access controls as the app tables.
REVOKE ALL PRIVILEGES ON TABLE "patient_payments" FROM PUBLIC;--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL PRIVILEGES ON TABLE "patient_payments" FROM anon;
 END IF;
END $$;
