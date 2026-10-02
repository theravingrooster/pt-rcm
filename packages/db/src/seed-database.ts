import type { Database } from "./index.js";
import { ptEligibilityShadowPack, ptPack, ptShadowPack, rulePackManifest } from "@pt-rcm/rules";
import { organizations, payers, providers, ruleSets, serviceFacilities } from "./schema.js";
import { seedFacility, seedOrganization, seedPayers, seedProviders } from "./seed-data.js";

export async function seedSyntheticData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(organizations).values(seedOrganization).onConflictDoNothing({ target: organizations.id });
    await tx.insert(serviceFacilities).values(seedFacility).onConflictDoNothing({ target: serviceFacilities.id });
    await tx.insert(providers).values(seedProviders).onConflictDoNothing({ target: providers.id });
    await tx.insert(payers).values(seedPayers).onConflictDoNothing({ target: payers.id });
    // Each candidate copies its predecessor: v2 adds timed-code-cap and v3
    // adds coverage-inactive. Reseeding never rewrites a tested or active pack.
    await tx.insert(ruleSets).values({ version: String(ptPack.version), status: "ACTIVE",
      notes: "SYN outpatient PT fixture", definitionJson: rulePackManifest(ptPack) }).onConflictDoNothing();
    await tx.insert(ruleSets).values({ version: String(ptShadowPack.version), status: "SHADOW",
      notes: "SYN candidate copied from v1 with timed-code-cap", definitionJson: rulePackManifest(ptShadowPack) }).onConflictDoNothing();
    await tx.insert(ruleSets).values({ version: String(ptEligibilityShadowPack.version), status: "SHADOW",
      notes: "SYN candidate copied from v2 with coverage-inactive", definitionJson: rulePackManifest(ptEligibilityShadowPack) }).onConflictDoNothing();
  });
}
