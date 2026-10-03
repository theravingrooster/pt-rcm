import { desc, eq } from "drizzle-orm";
import { IdSchema } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";

/** All saved versions remain visible; the encounter detail identifies its latest one. */
export async function listConsoleClaims(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  return db.select({ claim: s.claims, encounter: s.encounters, patient: s.patients, payer: s.payers })
    .from(s.claims)
    .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
    .innerJoin(s.patients, eq(s.patients.id, s.encounters.patientId))
    .innerJoin(s.payers, eq(s.payers.id, s.claims.payerId))
    .where(eq(s.encounters.organizationId, organizationId))
    .orderBy(desc(s.encounters.dateOfService), s.encounters.externalId, desc(s.claims.version));
}
