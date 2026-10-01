# pt-rcm

Outpatient physical therapy billing rules prototype. Synthetic data only. Fixture clearinghouse. No live claims.

Medicare plus one synthetic commercial payer. Professional claims only. The 8-minute rule, GP, KX, plan of care, and auth checks are the product. This repo does not submit to a payer.

## Setup

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm test
pnpm dev
```

Node 22. Package manager is pnpm. Do not use the old ClaimGuard npm scripts.

## What this does not do

- Live 837 submission
- Eligibility against real payers
- Redistribution of the AMA CPT data file
- Institutional claims
- Medical-necessity review
