import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import { ClaimNotSubmittable, IdSchema } from "@pt-rcm/domain";
import { ClaimDocumentReadError, ClaimSubmissionError, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, submitScrubbedClaim } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;
// This route can only construct the in-memory fixture. Configuration never
// dispatches to a live adapter, including when an API key exists in the environment.
const clearinghouse = new FixtureClearinghouse();
const headers = { "Cache-Control": "no-store" };

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_CLAIM_ID" }, { status: 400, headers });
  const adapter = process.env.CLEARINGHOUSE_ADAPTER;
  if (adapter !== "fixture") return Response.json({ error: "CLEARINGHOUSE_ADAPTER_DISABLED", message: "CLEARINGHOUSE_ADAPTER must be fixture" }, { status: 503, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const result = await submitScrubbedClaim(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data, { adapter, clearinghouse });
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof ClaimNotSubmittable) return Response.json({ error: error.code, message: error.message }, { status: 409, headers });
    if (error instanceof ClaimSubmissionError || error instanceof ClaimDocumentReadError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    }
    return Response.json({ error: "CLAIM_SUBMISSION_FAILED" }, { status: 500, headers });
  }
}
