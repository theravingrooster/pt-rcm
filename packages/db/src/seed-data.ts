import {
  OrganizationSchema, PayerSchema, ProviderSchema, ServiceFacilitySchema,
} from "@pt-rcm/domain";

const address = {
  line1: "1 SYN Test Way", line2: null, city: "SYN City",
  state: "CA", postalCode: "00000", country: "US",
};

// Stable UUIDs make repeated seeds safe. These fixtures contain no patients or claims.
export const seedOrganization = OrganizationSchema.parse({
  id: "00000000-0000-4000-8000-000000000001", name: "SYN Ortho PT",
  billingNpi: "0000000001", taxId: "SYN-TAX-1", taxonomyCode: "225100000X", address,
});
export const seedFacility = ServiceFacilitySchema.parse({
  id: "00000000-0000-4000-8000-000000000002", organizationId: seedOrganization.id,
  name: "SYN Ortho PT Office", npi: "0000000002", address,
});
export const seedProviders = [
  ProviderSchema.parse({
    id: "00000000-0000-4000-8000-000000000003", organizationId: seedOrganization.id,
    firstName: "SYN", lastName: "Renderer One", npi: "0000000003",
    taxonomyCode: "225100000X", role: "RENDERING",
  }),
  ProviderSchema.parse({
    id: "00000000-0000-4000-8000-000000000004", organizationId: seedOrganization.id,
    firstName: "SYN", lastName: "Renderer Two", npi: "0000000004",
    taxonomyCode: "225100000X", role: "RENDERING",
  }),
];
export const seedPayers = [
  PayerSchema.parse({
    id: "00000000-0000-4000-8000-000000000005", name: "Medicare",
    payerType: "MEDICARE", stediPayerId: null, requiresGpModifier: true,
    authRequired: false, unitRule: "MEDICARE_8_MINUTE",
  }),
  PayerSchema.parse({
    id: "00000000-0000-4000-8000-000000000006", name: "SYN Commercial",
    payerType: "COMMERCIAL", stediPayerId: null, requiresGpModifier: false,
    authRequired: true, unitRule: "MEDICARE_8_MINUTE",
  }),
];
