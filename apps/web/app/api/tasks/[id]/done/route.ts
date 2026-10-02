import { IdSchema } from "@pt-rcm/domain";
import { completeTask, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, TaskNotFound } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Cache-Control": "no-store" };

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_TASK_ID" }, { status: 400, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const task = await completeTask(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data);
    return Response.json({ task }, { headers });
  } catch (error) {
    if (error instanceof TaskNotFound) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    return Response.json({ error: "TASK_COMPLETION_FAILED" }, { status: 500, headers });
  }
}
