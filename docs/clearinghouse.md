# Fixture clearinghouse boundary

`ClearinghousePort` accepts a typed `ClaimDocument`. `FixtureClearinghouse` runs
entirely in memory and records every method and its detached input in `calls`.
Eligibility is active only for a member ID beginning with `SYN`. Submission
returns `{ status: "accepted-for-processing", icn: "SYN-ICN-<claim UUID>" }`.
This acknowledgment is a fixture receipt, not payer adjudication.

To script a remit, construct a fixture with
`{ claimId, totalChargeCents, receivedOn: "2026-10-02" }`. `fetchRemits(since)`
returns that claim's remit when its received date is on or after the ISO date or
UTC timestamp supplied. With no script it returns an empty array. The payer's
80% is rounded to the nearest cent; the remaining cents are patient coinsurance.
The PR-2 adjustment amount equals that patient portion. Repeated reads return
fresh copies and do not consume the script. No remit persistence is added here.

`StediClearinghouse` requires the caller to supply a nonempty `STEDI_API_KEY`
value to its constructor. The key is not retained or used. Every method throws
`ClearinghouseDisabled("live adapter is not enabled in this prototype")`.
The package has no network calls, and the 837P mapper remains a throwing stub.

`POST /api/claims/:id/submit` takes no body and requires the server environment
`CLEARINGHOUSE_ADAPTER=fixture` exactly. Missing or other values return 503,
even if an API key exists. The route constructs only the in-memory fixture and
uses `INGEST_ORGANIZATION_ID` for tenant scope. Invalid IDs return 400;
missing/cross-organization claims return 404; non-scrubbed, superseded, or stale
claims return 409. Invalid document sources return 422.

On a valid acknowledgment, one database transaction changes the claim to
`SUBMITTED`, marks its encounter `CLAIMED`, and writes `CLAIM_SUBMITTED` to
AuditEvent. `Claim.snapshotJson.submission` stores `adapter`, `acknowledgment`
(including the fake `icn`), the exact `document`, and UTC `submittedAt`.
Existing snapshot data and RuleFire rows are preserved. Encounter/claim locks
prevent concurrent duplicate submits; a repeat request returns 409 without an
adapter call. Adapter failures or invalid acknowledgments do not update status.
