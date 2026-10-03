import { IdSchema, MoneyCentsSchema } from "@pt-rcm/domain";
import { createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, PatientPaymentError, recordPatientPayment } from "@pt-rcm/db";

export const runtime = "nodejs";
let connection: ReturnType<typeof createDatabase> | undefined;
const headers = { "Cache-Control": "no-store" };
const positiveCents = MoneyCentsSchema.min(1);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = IdSchema.safeParse((await context.params).id);
  if (!parsed.success) return Response.json({ error: "INVALID_CLAIM_ID" }, { status: 400, headers });
  let body: { paymentId: string; amountCents: number } | null = null;
  try {
    const value: unknown = await request.json();
    if (value && typeof value === "object") {
      const entry = value as Record<string, unknown>;
      if (IdSchema.safeParse(entry.paymentId).success && positiveCents.safeParse(entry.amountCents).success) {
        body = { paymentId: entry.paymentId as string, amountCents: entry.amountCents as number };
      }
    }
  } catch { /* invalid JSON */ }
  if (!body) return Response.json({ error: "INVALID_PAYMENT", message: "Enter a positive payment in cents." }, { status: 400, headers });
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    const result = await recordPatientPayment(connection.db,
      process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID, parsed.data, body.paymentId, body.amountCents);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof PatientPaymentError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    return Response.json({ error: "PATIENT_PAYMENT_FAILED" }, { status: 500, headers });
  }
}
