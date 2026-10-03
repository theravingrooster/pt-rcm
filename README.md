# pt-rcm

Outpatient physical therapy billing rules prototype. Synthetic data only. Fixture clearinghouse. No live claims.

Medicare uses the daily 8-minute rule. Some commercial payers use AMA midpoint units per code; the SYN Commercial fixture uses the Medicare 8-minute rule.

## Run locally

```bash
pnpm install
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
pnpm demo
pnpm dev
```

`apps/web` can be deployed to Vercel with `DATABASE_URL` and `CLEARINGHOUSE_ADAPTER=fixture`. Do not set live payer credentials.

## What this does not do

- Live 837 submission
- Eligibility against real payers
- CPT licensing or redistribution of the AMA CPT data file
- Institutional claims
- Medical-necessity review or secondary COB
