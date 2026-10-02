ALTER TABLE "rule_fires" ADD COLUMN "rule_set_id" uuid;--> statement-breakpoint
ALTER TABLE "rule_sets" ADD COLUMN "definition_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_fires" ADD CONSTRAINT "rule_fires_rule_set_id_rule_sets_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."rule_sets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_fires_rule_set_claim_idx" ON "rule_fires" USING btree ("rule_set_id","claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rule_sets_one_active" ON "rule_sets" USING btree ("status") WHERE "rule_sets"."status" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "rule_sets" ADD CONSTRAINT "rule_sets_definition_object" CHECK (jsonb_typeof("rule_sets"."definition_json") = 'object');--> statement-breakpoint
-- An active definition is permanent evidence of the policy that ran. Its only
-- permitted change is retirement during a promotion; retired rows stay frozen.
CREATE FUNCTION protect_rule_set_definition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('ACTIVE', 'RETIRED') OR (OLD.status = 'SHADOW' AND EXISTS (
      SELECT 1 FROM rule_fires WHERE rule_set_id = OLD.id AND shadow = true
    )) THEN
      RAISE EXCEPTION 'active, retired, or tested shadow rule packs are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'RETIRED' OR
     (OLD.status = 'ACTIVE' AND (
       NEW.status <> 'RETIRED' OR NEW.id IS DISTINCT FROM OLD.id OR
       NEW.version IS DISTINCT FROM OLD.version OR NEW.notes IS DISTINCT FROM OLD.notes OR
       NEW.definition_json IS DISTINCT FROM OLD.definition_json)) THEN
    RAISE EXCEPTION 'active or retired rule packs are immutable' USING ERRCODE = '23514';
  END IF;
  -- Evidence for a shadow run applies to the exact definition that was tested.
  IF OLD.status = 'SHADOW' AND EXISTS (
    SELECT 1 FROM rule_fires WHERE rule_set_id = OLD.id AND shadow = true
  ) AND (NEW.status NOT IN ('SHADOW', 'ACTIVE') OR NEW.id IS DISTINCT FROM OLD.id OR NEW.version IS DISTINCT FROM OLD.version OR
          NEW.notes IS DISTINCT FROM OLD.notes OR NEW.definition_json IS DISTINCT FROM OLD.definition_json) THEN
    RAISE EXCEPTION 'tested shadow rule packs are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SHADOW' AND NEW.status = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM rule_fires WHERE rule_set_id = OLD.id AND shadow = true
  ) THEN
    RAISE EXCEPTION 'shadow evidence is required before activation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER rule_sets_protect_definition BEFORE UPDATE OR DELETE ON rule_sets
  FOR EACH ROW EXECUTE FUNCTION protect_rule_set_definition();
