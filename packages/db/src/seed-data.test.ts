import { describe, expect, it } from "vitest";
import { OrganizationSchema, PayerSchema, ProviderSchema, ServiceFacilitySchema } from "@pt-rcm/domain";
import { seedFacility, seedOrganization, seedPayers, seedProviders } from "./seed-data.js";

describe("synthetic seed fixtures", () => {
  it("has exactly the requested configuration", () => {
    expect(OrganizationSchema.parse(seedOrganization).name).toBe("SYN Ortho PT");
    expect(seedOrganization.taxId).toBe("SYN-TAX-1");
    expect(ServiceFacilitySchema.parse(seedFacility).placeOfServiceCode).toBe("11");
    expect(seedProviders).toHaveLength(2);
    for (const provider of seedProviders) {
      expect(ProviderSchema.parse(provider).role).toBe("RENDERING");
      expect(provider.organizationId).toBe(seedOrganization.id);
    }
    expect(seedPayers.map((payer) => PayerSchema.parse(payer).name)).toEqual(["Medicare", "SYN Commercial"]);
    expect(seedPayers.every((payer) => payer.stediPayerId === null)).toBe(true);
    expect(seedPayers.map(({ requiresGpModifier, authRequired, unitRule }) => ({ requiresGpModifier, authRequired, unitRule }))).toEqual([
      { requiresGpModifier: true, authRequired: false, unitRule: "MEDICARE_8_MINUTE" },
      { requiresGpModifier: false, authRequired: true, unitRule: "MEDICARE_8_MINUTE" },
    ]);
  });
});
