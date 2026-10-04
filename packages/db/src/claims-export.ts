import { sql } from "drizzle-orm";
import { ClaimStatusSchema, IdSchema, IsoDateSchema, type ClaimStatus } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";

export type ClaimExportRow = {
  claimId: string;
  version: number;
  patientExternalId: string;
  dateOfService: string;
  payer: string;
  status: ClaimStatus;
  chargeCents: number;
  paidCents: number;
  patientResponsibilityCents: number;
  units: number;
  cptCodes: string[];
};

export type ClaimExportPage = { rows: ClaimExportRow[]; nextCursor: string | null };
export type ClaimExportOptions = { status?: ClaimStatus; limit?: number; cursor?: string };

export class ClaimExportQueryError extends Error {
  readonly status = 400;
  readonly code = "INVALID_EXPORT_QUERY";
  constructor() { super("Invalid claim export query"); this.name = "ClaimExportQueryError"; }
}

type Cursor = { organizationId: string; status: ClaimStatus | null; dateOfService: string; claimId: string; version: number };
function invalid(): never { throw new ClaimExportQueryError(); }

function decodeCursor(value: string, organizationId: string, status: ClaimStatus | null): Cursor {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== value) invalid();
    const cursor: unknown = JSON.parse(decoded);
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) invalid();
    const row = cursor as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "claimId,dateOfService,organizationId,status,version"
      || row.organizationId !== organizationId || row.status !== status
      || !IsoDateSchema.safeParse(row.dateOfService).success || !IdSchema.safeParse(row.claimId).success
      || !Number.isInteger(row.version) || (row.version as number) < 1) invalid();
    return row as Cursor;
  } catch { return invalid(); }
}

function encodeCursor(row: ClaimExportRow, organizationId: string, status: ClaimStatus | null): string {
  return Buffer.from(JSON.stringify({ organizationId, status, dateOfService: row.dateOfService,
    claimId: row.claimId, version: row.version })).toString("base64url");
}

/** The claim row is mutable on denial resubmission. Its saved submissionHistory
 * holds the earlier submitted documents, so expand those into one row per
 * claim ID/version before applying the keyset cursor and page size.
 */
export async function readClaimExport(db: Database, organizationId: string, options: ClaimExportOptions = {}): Promise<ClaimExportPage> {
  IdSchema.parse(organizationId);
  const limit = options.limit ?? 50;
  const status = options.status ?? null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200
    || (status !== null && !ClaimStatusSchema.safeParse(status).success)) invalid();
  const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor, organizationId, status);
  const filter = status === null ? sql`` : sql`AND v.status = ${status}`;
  const after = cursor === null ? sql`` : sql`AND (
    v.date_of_service < ${cursor.dateOfService}
    OR (v.date_of_service = ${cursor.dateOfService} AND v.claim_id < ${cursor.claimId})
    OR (v.date_of_service = ${cursor.dateOfService} AND v.claim_id = ${cursor.claimId} AND v.version < ${cursor.version})
  )`;
  const result = await db.execute(sql`
    WITH current_claims AS (
      SELECT c.id AS claim_id, c.version, c.status::text AS status,
        c.total_charge_cents AS charge_cents, c.snapshot_json,
        e.date_of_service, p.external_id AS patient_external_id, py.name AS payer
      FROM ${s.claims} c
      JOIN ${s.encounters} e ON e.id = c.encounter_id
      JOIN ${s.patients} p ON p.id = e.patient_id
      JOIN ${s.payers} py ON py.id = c.payer_id
      WHERE e.organization_id = ${organizationId}
    ), versioned AS (
      SELECT c.claim_id, c.version, c.status, c.charge_cents,
        c.date_of_service, c.patient_external_id, c.payer,
        COALESCE((SELECT SUM(cl.units)::integer FROM ${s.claimLines} cl WHERE cl.claim_id = c.claim_id), 0) AS units,
        COALESCE((SELECT array_agg(cl.cpt_code ORDER BY cl.cpt_code, cl.id)
          FROM ${s.claimLines} cl WHERE cl.claim_id = c.claim_id), ARRAY[]::text[]) AS cpt_codes
      FROM current_claims c
      UNION ALL
      SELECT c.claim_id, (h.item->>'version')::integer AS version,
        'DENIED'::text AS status,
        (h.item->'submission'->'document'->>'totalChargeCents')::integer AS charge_cents,
        c.date_of_service, c.patient_external_id, c.payer,
        COALESCE((SELECT SUM((l.item->>'units')::integer)::integer
          FROM jsonb_array_elements(h.item->'submission'->'document'->'lines') l(item)), 0) AS units,
        COALESCE((SELECT array_agg(l.item->>'cptCode' ORDER BY l.item->>'cptCode', l.ordinality)
          FROM jsonb_array_elements(h.item->'submission'->'document'->'lines') WITH ORDINALITY l(item, ordinality)), ARRAY[]::text[]) AS cpt_codes
      FROM current_claims c
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.snapshot_json->'submissionHistory', '[]'::jsonb)) h(item)
      WHERE (h.item->>'version')::integer < c.version
    )
    SELECT v.claim_id AS "claimId", v.version, v.patient_external_id AS "patientExternalId",
      v.date_of_service AS "dateOfService", v.payer, v.status,
      v.charge_cents AS "chargeCents", r.paid_cents AS "paidCents",
      r.patient_responsibility_cents AS "patientResponsibilityCents",
      v.units, v.cpt_codes AS "cptCodes"
    FROM versioned v
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(remit.paid_cents)::integer, 0) AS paid_cents,
        COALESCE(SUM(remit.patient_responsibility_cents)::integer, 0) AS patient_responsibility_cents
      FROM ${s.remits} remit
      WHERE remit.claim_id = v.claim_id
        AND remit.detail_json->'claimVersion' = to_jsonb(v.version)
        AND remit.detail_json->'result'->>'matched' = 'true'
    ) r
    WHERE true ${filter} ${after}
    ORDER BY v.date_of_service DESC, v.claim_id DESC, v.version DESC
    LIMIT ${limit + 1}
  `);
  // The SQL projection above is deliberately exhaustive; neither a patient
  // object nor a saved claim document is returned by the database query.
  const page = result as unknown as ClaimExportRow[];
  const rows = page.slice(0, limit);
  return { rows, nextCursor: page.length > limit ? encodeCursor(rows[rows.length - 1]!, organizationId, status) : null };
}
