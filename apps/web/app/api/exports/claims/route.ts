import { ClaimStatusSchema } from "@pt-rcm/domain";
import { ClaimExportQueryError, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, readClaimExport } from "@pt-rcm/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
let connection: ReturnType<typeof createDatabase> | undefined;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawStatus = params.get("status");
  const rawLimit = params.get("limit");
  const rawCursor = params.get("cursor");
  const status = rawStatus === null ? undefined : ClaimStatusSchema.safeParse(rawStatus);
  if ((status && !status.success) || (rawLimit !== null && (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 200))
    || (rawCursor !== null && rawCursor.length === 0)
    || ["status", "limit", "cursor"].some((key) => params.getAll(key).length > 1)) {
    return Response.json({ error: "INVALID_EXPORT_QUERY" }, { status: 400, headers });
  }
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const page = await readClaimExport(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID,
      { status: status?.success ? status.data : undefined, limit: rawLimit === null ? undefined : Number(rawLimit),
        cursor: rawCursor ?? undefined });
    return Response.json(page, { headers });
  } catch (error) {
    if (error instanceof ClaimExportQueryError) return Response.json({ error: error.code }, { status: error.status, headers });
    return Response.json({ error: "CLAIM_EXPORT_FAILED" }, { status: 500, headers });
  }
}
