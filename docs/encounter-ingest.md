# Synthetic encounter ingest

`POST /api/encounters` accepts the Zod contract exported as `EncounterIngestSchema`
from `@pt-rcm/domain`. See `fixtures/encounters/shoulder-23min.json` for a complete
synthetic request. Only local fixture procedure codes are accepted.

- `patient.name` accepts `{ firstName, lastName }` or a full name string. For a
  string, the first word becomes `firstName` and the remaining words `lastName`.
- `patient.coverage.payerCode` is `MEDICARE` or `SYN_COMMERCIAL`; `relationship`
  is `SELF`, `SPOUSE`, `CHILD`, or `OTHER`. The payer codes resolve to seeded payers.
- Patient external IDs start with `SYN`, member IDs with `SYN`, and NPIs with `000`.
  All supplied names, addresses, and other patient data must also be synthetic.
- The server uses `INGEST_ORGANIZATION_ID`, defaulting to the seeded SYN Ortho PT
  organization. The request cannot override it. This local prototype has no
  authentication and must not be exposed as a public patient intake endpoint.
- Responses are `201` for create and `200` for replacement, with
  `{ encounterId, patientId, status: "DRAFT", created }`. Invalid JSON or body is
  `400`; missing or mismatched references are `422`; a non-editable encounter or
  a claim at or beyond submission is `409`.
- Replays replace minute lines and diagnoses in request order (first diagnosis
  is primary). Patient demographics and coverage are upserted. Empty arrays are
  allowed for drafts. Supplied minutes are preserved; no units are allocated.
- Each patient/payer has one coverage record. Missing group number, plan name,
  and plan-of-care expiry are stored as `null`; existing values are preserved.
  Identical patient/signature/date plans are reused. Omitted plans leave patient
  plans intact; omitted `authorizationId` clears the encounter reference.
- An authorization must belong to the supplied patient and payer. No expiration,
  utilization, eligibility, certification, or other billing rules run at ingest.
- Every successful request, including a replay, writes `ENCOUNTER_UPSERTED` in the
  same transaction. Rejected requests leave no partial patient or encounter data.

Run `pnpm seed:demo` while the web server is running, after migrations and the
configuration seed. `ENCOUNTER_API_URL` overrides the default
`http://localhost:3000/api/encounters`. Repeated runs update the same draft.
