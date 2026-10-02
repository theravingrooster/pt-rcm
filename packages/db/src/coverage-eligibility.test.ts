import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixtureClearinghouse, type ClearinghousePort } from "@pt-rcm/clearinghouse";
import { checkCoverageEligibility, CoverageEligibilityError, createDatabase } from "./index.js";
import { seedSyntheticData } from "./seed-database.js";
import { seedOrganization, seedPayers } from "./seed-data.js";
import * as s from "./schema.js";

const url = process.env.TEST_DATABASE_URL;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const patientId = randomUUID();
const otherPatientId = randomUUID();
const coverageId = randomUUID();
const otherCoverageId = randomUUID();
const memberId = `SYN-MEMBER-${randomUUID()}`;

describe.skipIf(!url)("fixture eligibility cache", () => {
  let connection: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    connection = createDatabase(url!);
    await seedSyntheticData(connection.db);
    await connection.db.insert(s.organizations).values([
      { ...seedOrganization, id: organizationId, name: "SYN Eligibility Org" },
      { ...seedOrganization, id: otherOrganizationId, name: "SYN Other Eligibility Org" },
    ]);
    await connection.db.insert(s.patients).values([
      { id: patientId, organizationId, externalId: `SYN-PAT-${patientId}`, firstName: "SYN", lastName: "Eligibility", dob: "2000-01-01", sex: "U", address: seedOrganization.address },
      { id: otherPatientId, organizationId: otherOrganizationId, externalId: `SYN-PAT-${otherPatientId}`, firstName: "SYN", lastName: "Other Eligibility", dob: "2000-01-01", sex: "U", address: seedOrganization.address },
    ]);
    await connection.db.insert(s.coverages).values([
      { id: coverageId, patientId, payerId: seedPayers[0]!.id, memberId, subscriberRelationship: "SELF", active: true },
      { id: otherCoverageId, patientId: otherPatientId, payerId: seedPayers[0]!.id, memberId: `SYN-MEMBER-${otherPatientId}`, subscriberRelationship: "SELF", active: true },
    ]);
  });
  afterEach(async () => {
    await connection.db.update(s.coverages).set({ eligible: null, checkedAt: null, deductibleRemainingCents: null, planActive: null })
      .where(eq(s.coverages.id, coverageId));
  });
  afterAll(async () => {
    if (!connection) return;
    try {
      await connection.db.delete(s.coverages).where(eq(s.coverages.id, coverageId));
      await connection.db.delete(s.coverages).where(eq(s.coverages.id, otherCoverageId));
      await connection.db.delete(s.patients).where(eq(s.patients.id, patientId));
      await connection.db.delete(s.patients).where(eq(s.patients.id, otherPatientId));
      await connection.db.delete(s.organizations).where(eq(s.organizations.id, organizationId));
      await connection.db.delete(s.organizations).where(eq(s.organizations.id, otherOrganizationId));
    } finally { await connection.client.end(); }
  });

  const fixtureOptions = (clearinghouse: Pick<ClearinghousePort, "checkEligibility">) => ({ adapter: "fixture", clearinghouse });
  const savedCoverage = async () => (await connection.db.select().from(s.coverages).where(eq(s.coverages.id, coverageId)))[0]!;

  it("checks a SYN member through the fixture and caches an active result with a UTC timestamp", async () => {
    const fixture = new FixtureClearinghouse();
    const start = Date.now();
    const result = await checkCoverageEligibility(connection.db, organizationId, coverageId, fixtureOptions(fixture));
    const end = Date.now();
    expect(fixture.calls).toEqual([{ method: "checkEligibility", request: { memberId } }]);
    expect(result).toMatchObject({ coverageId, adapter: "fixture", eligible: true, planActive: true, deductibleRemainingCents: null });
    expect(Date.parse(result.checkedAt!)).toBeGreaterThanOrEqual(start);
    expect(Date.parse(result.checkedAt!)).toBeLessThanOrEqual(end);
    expect(await savedCoverage()).toMatchObject({ eligible: true, checkedAt: result.checkedAt, planActive: true, deductibleRemainingCents: null });
  });

  it("stores an inactive fixture response without changing the member ID or manually entered active flag", async () => {
    const fake = { checkEligibility: vi.fn(async () => ({ memberId, eligible: false, coverageStatus: "inactive" as const })) };
    const result = await checkCoverageEligibility(connection.db, organizationId, coverageId, fixtureOptions(fake));
    expect(result).toMatchObject({ eligible: false, planActive: false, deductibleRemainingCents: null });
    expect(await savedCoverage()).toMatchObject({ memberId, active: true, eligible: false, planActive: false });
  });

  it("does not call the adapter or change data when coverage is missing or belongs to another organization", async () => {
    const fixture = new FixtureClearinghouse();
    for (const id of [randomUUID(), otherCoverageId]) {
      await expect(checkCoverageEligibility(connection.db, organizationId, id, fixtureOptions(fixture)))
        .rejects.toMatchObject({ status: 404, code: "COVERAGE_NOT_FOUND" });
    }
    expect(fixture.calls).toEqual([]);
    expect(await savedCoverage()).toMatchObject({ eligible: null, checkedAt: null });
  });

  it("refuses non-fixture adapters before a database lookup or adapter call", async () => {
    const fixture = new FixtureClearinghouse();
    await expect(checkCoverageEligibility(connection.db, organizationId, coverageId, { adapter: "stedi", clearinghouse: fixture }))
      .rejects.toEqual(new CoverageEligibilityError(503, "CLEARINGHOUSE_ADAPTER_DISABLED", "CLEARINGHOUSE_ADAPTER must be fixture"));
    expect(fixture.calls).toEqual([]);
    expect(await savedCoverage()).toMatchObject({ eligible: null, checkedAt: null });
  });

  it("rejects a mismatched fixture member without overwriting the cache", async () => {
    const fake = { checkEligibility: vi.fn(async () => ({ memberId: "SYN-WRONG", eligible: false, coverageStatus: "inactive" as const })) };
    await expect(checkCoverageEligibility(connection.db, organizationId, coverageId, fixtureOptions(fake)))
      .rejects.toMatchObject({ status: 502, code: "INVALID_ELIGIBILITY_RESULT" });
    expect(await savedCoverage()).toMatchObject({ eligible: null, checkedAt: null });
  });
});
