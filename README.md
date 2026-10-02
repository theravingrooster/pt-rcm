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
docker compose up -d
pnpm db:migrate
pnpm test
pnpm dev
```

## What this does not do

- Live 837 submission
- Eligibility against real payers
- Redistribution of the AMA CPT data file
- Institutional claims
- Medical-necessity review
