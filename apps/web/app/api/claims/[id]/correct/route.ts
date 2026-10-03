import { IdSchema, NonNegativeIntSchema } from "@pt-rcm/domain";
import { correctDeniedClaim, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID,
  DenialCorrectionError, EncounterScrubError, RulePackError } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Cache-Control": "no-store" };
const unitSchema = NonNegativeIntSchema.min(1);
type Edit = { claimLineId: string; units: number; modifiers: string[] };

function parseCorrection(value: unknown): Edit[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { lines?: unknown }).lines)) return null;
  const lines = (value as { lines: unknown[] }).lines;
  if (!lines.length) return null;
  const edits: Edit[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object") return null;
    const entry = line as Record<string, unknown>;
    if (!IdSchema.safeParse(entry.claimLineId).success || !unitSchema.safeParse(entry.units).success
      || !Array.isArray(entry.modifiers) || !entry.modifiers.every((modifier) => typeof modifier === "string" && /^[A-Z0-9]{2}$/.test(modifier))) return null;
    edits.push({ claimLineId: entry.claimLineId as string, units: entry.units as number, modifiers: entry.modifiers as string[] });
  }
  return edits;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_CLAIM_ID" }, { status: 400, headers });
  let body: Edit[] | null = null;
  try { body = parseCorrection(await request.json()); } catch { /* invalid JSON */ }
  if (!body) return Response.json({ error: "INVALID_CORRECTION", message: "Supply units and modifiers for each claim line." }, { status: 400, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const result = await correctDeniedClaim(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data, body);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof DenialCorrectionError || error instanceof EncounterScrubError || error instanceof RulePackError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    }
    return Response.json({ error: "CLAIM_CORRECTION_FAILED" }, { status: 500, headers });
  }
}
