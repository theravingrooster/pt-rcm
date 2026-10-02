import { MoneyCentsSchema, NonNegativeIntSchema } from "../models.js";

// CPT is an AMA-licensed code set. This local test fixture is not a redistribution
// of the CPT data file. These invented fees are not Medicare reimbursement rates.
export const PT_FIXTURE_FEES_CENTS: Readonly<Record<string, number>> = Object.freeze({
  "97161": 12000, "97162": 12000, "97163": 12000,
  "97110": 4500, "97112": 4500, "97140": 4500, "97530": 4500, "97535": 4500,
  "G0283": 2000,
});

// Untimed services have one allocated unit. Zero-unit draft lines have no charge.
export function fixtureLineChargeCents(cptCode: string, units: number): number {
  NonNegativeIntSchema.parse(units);
  const fee = Object.hasOwn(PT_FIXTURE_FEES_CENTS, cptCode) ? PT_FIXTURE_FEES_CENTS[cptCode] : undefined;
  if (fee === undefined) throw new RangeError("No fixture fee for procedure code");
  return MoneyCentsSchema.parse(fee * units);
}
