ALTER TABLE "coverages" ALTER COLUMN "group_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "coverages" ALTER COLUMN "plan_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plans_of_care" ALTER COLUMN "expires_on" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "authorization_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "encounters" ADD CONSTRAINT "encounters_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_patient_payer_unique" UNIQUE("patient_id","payer_id");