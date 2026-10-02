// CPT is an AMA-licensed code set. This is a local test fixture, not a
// redistribution of the CPT data file. Only the explicitly requested rows are included.
// G0283 is a HCPCS Level II code included here for the Medicare test scenario.
const cptFixtures = Object.freeze(([
  { code: "97161", name: "PT eval low", timed: false, codeSystem: "CPT" },
  { code: "97162", name: "PT eval moderate", timed: false, codeSystem: "CPT" },
  { code: "97163", name: "PT eval high", timed: false, codeSystem: "CPT" },
  { code: "97110", name: "therapeutic exercise", timed: true, codeSystem: "CPT" },
  { code: "97112", name: "neuromuscular re-ed", timed: true, codeSystem: "CPT" },
  { code: "97140", name: "manual therapy", timed: true, codeSystem: "CPT" },
  { code: "97530", name: "therapeutic activities", timed: true, codeSystem: "CPT" },
  { code: "97535", name: "self-care/home management", timed: true, codeSystem: "CPT" },
  { code: "G0283", name: "electrical stimulation unattended (Medicare)", timed: false, codeSystem: "HCPCS" },
] as const).map((row) => Object.freeze(row)));

export type CptFixture = (typeof cptFixtures)[number];
export type CptFixtureCode = CptFixture["code"];

export function loadCptFixtures(): readonly CptFixture[] {
  return cptFixtures;
}

export function getCptFixture(code: string): CptFixture | undefined {
  return cptFixtures.find((row) => row.code === code);
}
