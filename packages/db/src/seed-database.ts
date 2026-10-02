import type { Database } from "./index.js";
import { organizations, payers, providers, serviceFacilities } from "./schema.js";
import { seedFacility, seedOrganization, seedPayers, seedProviders } from "./seed-data.js";

export async function seedSyntheticData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(organizations).values(seedOrganization).onConflictDoNothing({ target: organizations.id });
    await tx.insert(serviceFacilities).values(seedFacility).onConflictDoNothing({ target: serviceFacilities.id });
    await tx.insert(providers).values(seedProviders).onConflictDoNothing({ target: providers.id });
    await tx.insert(payers).values(seedPayers).onConflictDoNothing({ target: payers.id });
  });
}
