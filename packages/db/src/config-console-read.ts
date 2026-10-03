import { eq } from "drizzle-orm";
import { IdSchema } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";

/** Configuration read models for the synthetic operator organization. */
export async function listConsoleProviders(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  return db.select().from(s.providers).where(eq(s.providers.organizationId, organizationId))
    .orderBy(s.providers.lastName, s.providers.firstName, s.providers.npi);
}

export async function listConsoleServiceFacilities(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  return db.select().from(s.serviceFacilities).where(eq(s.serviceFacilities.organizationId, organizationId))
    .orderBy(s.serviceFacilities.name, s.serviceFacilities.npi);
}

// Payers are global configuration rows in the current schema; they have no organization key.
export async function listConsolePayers(db: Database) {
  return db.select({
    id: s.payers.id, name: s.payers.name, payerType: s.payers.payerType,
    requiresGpModifier: s.payers.requiresGpModifier, authRequired: s.payers.authRequired,
    unitRule: s.payers.unitRule,
  }).from(s.payers).orderBy(s.payers.name, s.payers.id);
}

export async function getConsoleOrganization(db: Database, organizationId: string) {
  IdSchema.parse(organizationId);
  const [organization] = await db.select().from(s.organizations)
    .where(eq(s.organizations.id, organizationId));
  return organization ?? null;
}
