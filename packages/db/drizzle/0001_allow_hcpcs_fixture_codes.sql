ALTER TABLE "claim_lines" DROP CONSTRAINT "claim_lines_cpt";--> statement-breakpoint
ALTER TABLE "encounter_minute_lines" DROP CONSTRAINT "encounter_minute_lines_cpt";--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_cpt" CHECK ("claim_lines"."cpt_code" ~ '^([0-9]{4}[0-9A-Z]|[A-Z][0-9]{4})$');--> statement-breakpoint
ALTER TABLE "encounter_minute_lines" ADD CONSTRAINT "encounter_minute_lines_cpt" CHECK ("encounter_minute_lines"."cpt_code" ~ '^([0-9]{4}[0-9A-Z]|[A-Z][0-9]{4})$');