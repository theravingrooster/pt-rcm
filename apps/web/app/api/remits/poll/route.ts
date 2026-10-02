import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import { IllegalClaimTransition, IsoDateSchema, RemitNotPostable, UtcTimestampSchema } from "@pt-rcm/domain";
import { createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, loadFixtureRemitScripts, pollRemits, RemitPostingError } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Cache-Control": "no-store" };

// Optional ?since=ISO-date-or-UTC-timestamp. The default replays fixture history;
// the persistent remit ID, not a process-local cursor, prevents double posting.
export async function POST(request: Request): Promise<Response> {
  const adapter = process.env.CLEARINGHOUSE_ADAPTER;
  if (adapter !== "fixture") return Response.json({ error: "CLEARINGHOUSE_ADAPTER_DISABLED" }, { status: 503, headers });
  const since = IsoDateSchema.or(UtcTimestampSchema).safeParse(new URL(request.url).searchParams.get("since") ?? "1970-01-01");
  if (!since.success) return Response.json({ error: "INVALID_REMIT_SINCE" }, { status: 400, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const organizationId = process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID;
    const clearinghouse = new FixtureClearinghouse(await loadFixtureRemitScripts(connection.db, organizationId));
    return Response.json(await pollRemits(connection.db, organizationId, since.data, { adapter, clearinghouse }), { headers });
  } catch (error) {
    if (error instanceof RemitPostingError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    if (error instanceof RemitNotPostable || error instanceof IllegalClaimTransition) return Response.json({ error: error.code, message: error.message }, { status: 409, headers });
    return Response.json({ error: "REMIT_POLL_FAILED" }, { status: 500, headers });
  }
}
