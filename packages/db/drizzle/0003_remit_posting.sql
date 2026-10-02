ALTER TABLE "remit_lines" ALTER COLUMN "carc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD COLUMN "patient_responsibility_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD COLUMN "adjustment_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD COLUMN "contractual_write_off_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD COLUMN "detail_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "remits" ADD COLUMN "adjustment_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remits" ADD COLUMN "detail_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD CONSTRAINT "remit_lines_adjustments" CHECK ("remit_lines"."patient_responsibility_cents" >= 0 AND "remit_lines"."adjustment_cents" >= 0 AND "remit_lines"."contractual_write_off_cents" >= 0 AND "remit_lines"."contractual_write_off_cents" <= "remit_lines"."adjustment_cents");--> statement-breakpoint
ALTER TABLE "remit_lines" ADD CONSTRAINT "remit_lines_detail_object" CHECK (jsonb_typeof("remit_lines"."detail_json") = 'object');--> statement-breakpoint
ALTER TABLE "remits" ADD CONSTRAINT "remits_adjustments" CHECK ("remits"."adjustment_cents" >= 0);--> statement-breakpoint
ALTER TABLE "remits" ADD CONSTRAINT "remits_detail_object" CHECK (jsonb_typeof("remits"."detail_json") = 'object');