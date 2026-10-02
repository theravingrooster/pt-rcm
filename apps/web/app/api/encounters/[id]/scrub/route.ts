import { IdSchema, IllegalClaimTransition } from "@pt-rcm/domain";
import { createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, EncounterScrubError, scrubEncounter } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_ENCOUNTER_ID" }, { status: 400 });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const result = await scrubEncounter(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data);
    return Response.json(result);
  } catch (error) {
    if (error instanceof IllegalClaimTransition) return Response.json({ error: error.code, message: error.message }, { status: 409 });
    if (error instanceof EncounterScrubError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    return Response.json({ error: "SCRUB_FAILED" }, { status: 500 });
  }
}
