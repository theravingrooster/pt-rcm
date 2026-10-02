import { IdSchema } from "@pt-rcm/domain";
import { applySuggestedModifier, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID,
  EncounterScrubError, ModifierApplicationError, RulePackError } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Cache-Control": "no-store" };

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_CLAIM_ID" }, { status: 400, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const result = await applySuggestedModifier(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof ModifierApplicationError || error instanceof EncounterScrubError || error instanceof RulePackError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    }
    return Response.json({ error: "MODIFIER_APPLICATION_FAILED" }, { status: 500, headers });
  }
}
