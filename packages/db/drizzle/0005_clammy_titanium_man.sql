ALTER TABLE "coverages" ADD COLUMN "eligible" boolean;--> statement-breakpoint
ALTER TABLE "coverages" ADD COLUMN "checked_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "coverages" ADD COLUMN "deductible_remaining_cents" integer;--> statement-breakpoint
ALTER TABLE "coverages" ADD COLUMN "plan_active" boolean;--> statement-breakpoint
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_deductible_nonnegative" CHECK ("coverages"."deductible_remaining_cents" IS NULL OR "coverages"."deductible_remaining_cents" >= 0);