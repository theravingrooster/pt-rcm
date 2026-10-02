# Encounter scrubbing

`POST /api/encounters/:id/scrub` takes no body. The server uses
`INGEST_ORGANIZATION_ID` (the seeded synthetic organization by default). It runs
the default active outpatient PT pack, version 1, and returns the claim ID,
version, status, priced total, draft lines, and all findings. A completed scrub
returns HTTP 200 for both `SCRUBBED` and `BLOCKED`; flags alone do not block.
Malformed IDs return 400, missing encounters 404, submitted claims 409, and
missing or ambiguous active coverage 422.

The first scrub allocates from the recorded minutes. Fixture prices in
`packages/domain/src/fixtures/fees.ts` are 12000 cents for evaluations, 4500 cents
per timed unit, and 2000 cents for G0283. These are invented test fees. The pack
may add GP, but never automatically adds KX, 59, or X modifiers or increases units.
All eight RuleFire rows, claim status, lines, and snapshot commit together.

A repeat scrub checks the saved units and modifiers; it does not overwrite them
with a fresh allocation. Changed encounter inputs create a new claim version.
Snapshots retain the source mapping, allocation, all draft lines, pack version,
and evaluation context. Zero-unit lines remain in the snapshot and findings;
the existing database ClaimLine model accepts only positive units.

KX uses billed charges for this patient+payer from January 1 through the date of
service, counting the latest submitted version of each other encounter once.
Draft and scrubbed charges are excluded. The fixture threshold is 248000 cents:
strictly above requires KX; strictly below with KX flags it. This prototype does
not check the medical-necessity documentation required for KX. A plan without
an expiry uses its signed date plus 90 UTC calendar days, inclusive.

The current model requires exactly one active coverage and selects the latest
plan signed on or before the service date (or blocks a future signature when no
such plan exists). No request to this endpoint submits anything to a payer.
