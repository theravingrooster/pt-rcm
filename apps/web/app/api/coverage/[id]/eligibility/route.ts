import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import { IdSchema } from "@pt-rcm/domain";
import { checkCoverageEligibility, CoverageEligibilityError, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Cache-Control": "no-store" };

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_COVERAGE_ID" }, { status: 400, headers });
  const adapter = process.env.CLEARINGHOUSE_ADAPTER;
  if (adapter !== "fixture") {
    return Response.json({ error: "CLEARINGHOUSE_ADAPTER_DISABLED", message: "CLEARINGHOUSE_ADAPTER must be fixture" }, { status: 503, headers });
  }
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const result = await checkCoverageEligibility(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data,
      { adapter, clearinghouse: new FixtureClearinghouse() });
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof CoverageEligibilityError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    }
    return Response.json({ error: "ELIGIBILITY_CHECK_FAILED" }, { status: 500, headers });
  }
}
