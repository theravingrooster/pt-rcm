CREATE TYPE "public"."unit_rule" AS ENUM('MEDICARE_8_MINUTE', 'AMA_MIDPOINT');--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "auth_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "unit_rule" "unit_rule" DEFAULT 'MEDICARE_8_MINUTE' NOT NULL;--> statement-breakpoint
-- Carry the existing fixture commercial payer forward without resetting a
-- payer's unit rule when synthetic seed is run again.
UPDATE "payers" SET "auth_required" = true WHERE "id" = '00000000-0000-4000-8000-000000000006' AND "payer_type" = 'COMMERCIAL';--> statement-breakpoint
-- Previously scrubbed snapshots retain the policy that was in force then.
UPDATE "claims" SET "snapshot_json" = jsonb_set("snapshot_json", '{payer}',
  '{"authRequired": false, "unitRule": "MEDICARE_8_MINUTE"}'::jsonb || ("snapshot_json" -> 'payer'))
WHERE jsonb_typeof("snapshot_json" -> 'payer') = 'object'
  AND (NOT (("snapshot_json" -> 'payer') ? 'authRequired') OR NOT (("snapshot_json" -> 'payer') ? 'unitRule'));
