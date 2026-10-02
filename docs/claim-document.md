# Internal claim document

`buildClaimDocument(source)` in `@pt-rcm/domain` validates canonical source records
and returns a Zod-validated `ClaimDocument`. It copies saved units, modifiers,
charges, and zero-based diagnosis pointers without running rules or repricing.
`renderClaimDocumentJson(document)` validates again and returns two-space-indented
JSON with a trailing newline. Assignment flags default to true.

Only `SCRUBBED` claims can build a document. Other statuses, including `BLOCKED`,
`DRAFT`, and `SHADOWED`, throw `ClaimNotSubmittable`. The fixture control number is
`SYN` followed by the last 12 hex characters of the claim UUID, in uppercase;
it stays stable for that claim and is not a clearinghouse identifier.

`GET /api/claims/:id/document` returns the pretty JSON with `Cache-Control:
no-store`. It uses the server's `INGEST_ORGANIZATION_ID` tenant scope. Invalid IDs
return 400, missing/cross-organization claims 404, non-scrubbed claims 409, and
inconsistent saved source data 422. Reading does not update status or write
RuleFire rows. Lines changed since the scrub must be scrubbed again.

The read service uses the claim version's scrub snapshot for service date,
diagnoses, coverage, payer, and line order. It loads current organization,
provider, facility, and patient demographics. Zero-unit source services stay
in the scrub snapshot; the document contains the saved billable claim lines.
For SELF coverage, subscriber demographics come from the patient. For other
relationships, `subscriber.person` is null because the model has no separate
subscriber demographics. Those details must be collected before a future mapping.

This is internal JSON, not X12 or a complete 837P. The clearinghouse package's
`x12/map837p.ts` lists only the requested loop outline and always throws
`NotImplemented`. It generates no raw X12 and calls no adapter.
