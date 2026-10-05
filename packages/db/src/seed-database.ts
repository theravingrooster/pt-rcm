import { eq } from "drizzle-orm";
import type { Database } from "./index.js";
import { ptEligibilityShadowPack, ptPack, ptPtaDeMinimisPack, ptPtaPack, ptShadowPack, rulePackManifest } from "@pt-rcm/rules";
import { organizations, payers, providers, ruleSets, serviceFacilities } from "./schema.js";
import { seedFacility, seedOrganization, seedPayers, seedProviders } from "./seed-data.js";

export async function seedSyntheticData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(organizations).values(seedOrganization).onConflictDoNothing({ target: organizations.id });
    await tx.insert(serviceFacilities).values(seedFacility).onConflictDoNothing({ target: serviceFacilities.id });
    await tx.insert(providers).values(seedProviders).onConflictDoNothing({ target: providers.id });
    await tx.insert(payers).values(seedPayers).onConflictDoNothing({ target: payers.id });
    // Preserve each deployed roster: v4 copies v1 and adds PTA/CQ, while v2
    // and v3 remain shadow candidates. Retire only the former active v1 row.
    await tx.insert(ruleSets).values({ version: String(ptPack.version), status: "RETIRED",
      notes: "SYN outpatient PT fixture", definitionJson: rulePackManifest(ptPack) }).onConflictDoNothing();
    await tx.insert(ruleSets).values({ version: String(ptShadowPack.version), status: "SHADOW",
      notes: "SYN candidate copied from v1 with timed-code-cap", definitionJson: rulePackManifest(ptShadowPack) }).onConflictDoNothing();
    await tx.insert(ruleSets).values({ version: String(ptEligibilityShadowPack.version), status: "SHADOW",
      notes: "SYN candidate copied from v2 with coverage-inactive", definitionJson: rulePackManifest(ptEligibilityShadowPack) }).onConflictDoNothing();
    const [active] = await tx.select().from(ruleSets).where(eq(ruleSets.status, "ACTIVE")).for("update");
    const [existingPta] = await tx.select().from(ruleSets).where(eq(ruleSets.version, String(ptPtaPack.version)));
    // A separately staged v4 must use the evidence-gated promotion path. Do
    // not retire v1 first and leave the database without an active pack.
    if (!existingPta && active?.version === String(ptPack.version)) {
      await tx.update(ruleSets).set({ status: "RETIRED" }).where(eq(ruleSets.id, active.id));
    }
    if (!existingPta && (!active || active.version === String(ptPack.version))) {
      await tx.insert(ruleSets).values({ version: String(ptPtaPack.version), status: "ACTIVE",
        notes: "SYN PTA/CQ policy copied from v1", definitionJson: rulePackManifest(ptPtaPack) }).onConflictDoNothing();
    }
    // Deploy the corrected de minimis roster as a new immutable version. Keep
    // an already staged v5 in SHADOW; only the evidence-gated path may promote it.
    const [existingDeMinimis] = await tx.select().from(ruleSets)
      .where(eq(ruleSets.version, String(ptPtaDeMinimisPack.version)));
    const [current] = await tx.select().from(ruleSets).where(eq(ruleSets.status, "ACTIVE")).for("update");
    if (!existingDeMinimis && current?.version === String(ptPtaPack.version)) {
      await tx.update(ruleSets).set({ status: "RETIRED" }).where(eq(ruleSets.id, current.id));
      await tx.insert(ruleSets).values({ version: String(ptPtaDeMinimisPack.version), status: "ACTIVE",
        notes: "SYN Medicare PTA de minimis policy copied from v4", definitionJson: rulePackManifest(ptPtaDeMinimisPack) });
    }
  });
}
