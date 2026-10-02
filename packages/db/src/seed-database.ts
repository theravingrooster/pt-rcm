import type { Database } from "./index.js";
import { ptPack, ptShadowPack, rulePackManifest } from "@pt-rcm/rules";
import { organizations, payers, providers, ruleSets, serviceFacilities } from "./schema.js";
import { seedFacility, seedOrganization, seedPayers, seedProviders } from "./seed-data.js";

export async function seedSyntheticData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(organizations).values(seedOrganization).onConflictDoNothing({ target: organizations.id });
    await tx.insert(serviceFacilities).values(seedFacility).onConflictDoNothing({ target: serviceFacilities.id });
    await tx.insert(providers).values(seedProviders).onConflictDoNothing({ target: providers.id });
    await tx.insert(payers).values(seedPayers).onConflictDoNothing({ target: payers.id });
    // The shadow roster is a copy of v1 plus timed-code-cap. Conflict handling
    // never rewrites an active or retired pack when the seed runs again.
    await tx.insert(ruleSets).values({ version: String(ptPack.version), status: "ACTIVE",
      notes: "SYN outpatient PT fixture", definitionJson: rulePackManifest(ptPack) }).onConflictDoNothing();
    await tx.insert(ruleSets).values({ version: String(ptShadowPack.version), status: "SHADOW",
      notes: "SYN candidate copied from v1 with timed-code-cap", definitionJson: rulePackManifest(ptShadowPack) }).onConflictDoNothing();
  });
}
