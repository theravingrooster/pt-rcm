# pt-rcm

Outpatient physical therapy billing rules prototype. Synthetic data only. Fixture clearinghouse. No live claims.

Medicare plus one synthetic commercial payer. Professional claims only. The 8-minute rule, GP, KX, plan of care, and auth checks are the product. This repo does not submit to a payer.

## Codex Cloud setup

Cloud has no Docker daemon. Do not run `docker compose` or `pnpm db:migrate` during environment setup.

```bash
bash scripts/cloud-setup.sh
```

That enables pnpm 9.15.0, installs dependencies, and runs the domain test. Node 22 is required.

## Local setup

```bash
pnpm install
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
pnpm test
TEST_DATABASE_URL=postgres://pt:pt@localhost:5432/pt_rcm pnpm --filter @pt-rcm/db test
pnpm typecheck
pnpm dev
# In another terminal, with the web server running:
pnpm seed:demo
```

Parse inputs with the schemas exported by `@pt-rcm/domain` before persistence. Generate migrations with `pnpm db:generate`. `DATABASE_URL` overrides the local Compose connection. The seed is idempotent and adds no patients. Database integration tests require `TEST_DATABASE_URL` and clean up their own synthetic clinical fixtures. The demo loader calls `POST /api/encounters`; see [the ingest contract](docs/encounter-ingest.md).

## What this does not do

- Live 837 submission
- Eligibility against real payers
- Redistribution of the AMA CPT data file
- Institutional claims
- Medical-necessity review
