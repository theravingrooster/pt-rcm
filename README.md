# pt-rcm

Outpatient physical therapy billing rules prototype. Synthetic data only. Fixture clearinghouse. No live claims.

## Run locally

```bash
pnpm install
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
pnpm demo
pnpm dev
```

## What this does not do

- Live 837 submission
- Eligibility against real payers
- CPT licensing or redistribution of the AMA CPT data file
- Institutional claims
- Medical-necessity review or secondary COB
