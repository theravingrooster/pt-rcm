# pt-rcm agent rules

This is a billing rules prototype for outpatient PT. It must never submit a claim to a real payer. Clearinghouse calls go through an interface; the default adapter is an in-memory fixture.

No real PHI. All patients, NPIs, member IDs, and tax IDs are obviously synthetic (NPI starts with 000, member IDs start with SYN).

Do not vendor the AMA CPT full file. Ship only the small PT code fixture explicitly listed, with a comment that CPT is licensed from the AMA and the fixture is for local tests.

Money is integer cents. Dates are ISO dates. Timestamps are UTC.

Domain functions in packages/domain and packages/rules are pure. No database imports there.

Every rule is data plus a pure evaluate function, versioned, and shadow-capable. Never hide a billing rule inside a React component or an API route.

A rule may flag, downgrade units, or block submission. A rule may never invent minutes, diagnoses, or services that were not on the encounter.

Tests are required for every domain function. Prefer table tests.

Do not add a README tutorial longer than the run steps.

Package root is pt-rcm. Workspaces are apps/* and packages/*.

## Codex Cloud

Environment setup must run `bash scripts/cloud-setup.sh` only. Do not run `docker compose` or `pnpm db:migrate` in cloud setup. There is no Docker daemon, no migrations folder, and the database schema is still a stub.
