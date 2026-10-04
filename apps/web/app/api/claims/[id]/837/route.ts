import { map837p, Synthetic837DocumentError } from "@pt-rcm/clearinghouse";
import { ClaimNotSubmittable, IdSchema } from "@pt-rcm/domain";
import { ClaimDocumentReadError, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, getClaimDocumentFor837 } from "@pt-rcm/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Cache-Control": "no-store" };

/** A local synthetic text download. Submission remains on the fixture route. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_CLAIM_ID" }, { status: 400, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const document = await getClaimDocumentFor837(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data);
    return new Response(map837p(document), { headers: {
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="SYN-claim-${parsed.data}-v${document.claimVersion}.837.txt"`,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof ClaimNotSubmittable) return Response.json({ error: error.code, message: error.message }, { status: 409, headers });
    if (error instanceof ClaimDocumentReadError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    if (error instanceof Synthetic837DocumentError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    return Response.json({ error: "SYNTHETIC_837_FAILED" }, { status: 500, headers });
  }
}
