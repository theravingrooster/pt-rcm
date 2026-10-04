import { LockedPtNoteSchema } from "@pt-rcm/domain";
import { ChartLockError, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, EncounterIngestError, lockPtChartNote } from "@pt-rcm/db";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
let connection: ReturnType<typeof createDatabase> | undefined;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400, headers });
  }
  const parsed = LockedPtNoteSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "INVALID_LOCKED_NOTE",
      issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
    }, { status: 400, headers });
  }
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const result = await lockPtChartNote(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data);
    return Response.json({ encounterId: result.encounterId }, { status: result.created ? 201 : 200, headers });
  } catch (error) {
    if (error instanceof ChartLockError || error instanceof EncounterIngestError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    }
    return Response.json({ error: "CHART_LOCK_FAILED" }, { status: 500, headers });
  }
}
