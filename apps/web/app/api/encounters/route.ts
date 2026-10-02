import { EncounterIngestSchema } from "@pt-rcm/domain";
import { createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, EncounterIngestError, upsertEncounter } from "@pt-rcm/db";

export const runtime = "nodejs";

let connection: ReturnType<typeof createDatabase> | undefined;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = EncounterIngestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "INVALID_ENCOUNTER",
      issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
    }, { status: 400 });
  }
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    // Tenant scope is server-owned; the payload cannot select another organization.
    const result = await upsertEncounter(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data);
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof EncounterIngestError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: "INGEST_FAILED" }, { status: 500 });
  }
}
