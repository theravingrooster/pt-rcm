import { TaskStatusSchema } from "@pt-rcm/domain";
import { createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, listTasks } from "@pt-rcm/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const parsed = TaskStatusSchema.safeParse(new URL(request.url).searchParams.get("status") ?? "OPEN");
  if (!parsed.success) return Response.json({ error: "INVALID_TASK_STATUS" }, { status: 400, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const tasks = await listTasks(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data);
    return Response.json({ tasks }, { headers });
  } catch {
    return Response.json({ error: "TASK_LIST_FAILED" }, { status: 500, headers });
  }
}
