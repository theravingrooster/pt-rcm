import { createDatabase, promoteRulePack, RulePackError } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;

export async function POST(request: Request, context: { params: Promise<{ version: string }> }): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "PROMOTION_CONFIRMATION_REQUIRED" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || (body as { confirm?: unknown }).confirm !== "PROMOTE") {
    return Response.json({ error: "PROMOTION_CONFIRMATION_REQUIRED" }, { status: 400 });
  }
  const { version } = await context.params;
  if (!/^\d+$/.test(version)) return Response.json({ error: "RULE_PACK_NOT_FOUND" }, { status: 404 });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    return Response.json(await promoteRulePack(connection.db, version));
  } catch (error) {
    if (error instanceof RulePackError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    return Response.json({ error: "PROMOTION_FAILED" }, { status: 500 });
  }
}
