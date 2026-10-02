import { ClaimNotSubmittable, IdSchema, renderClaimDocumentJson } from "@pt-rcm/domain";
import { ClaimDocumentReadError, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, getClaimDocument } from "@pt-rcm/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_CLAIM_ID" }, { status: 400, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const document = await getClaimDocument(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data);
    return new Response(renderClaimDocumentJson(document), { headers });
  } catch (error) {
    if (error instanceof ClaimNotSubmittable) return Response.json({ error: error.code, message: error.message }, { status: 409, headers });
    if (error instanceof ClaimDocumentReadError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    return Response.json({ error: "CLAIM_DOCUMENT_FAILED" }, { status: 500, headers });
  }
}
