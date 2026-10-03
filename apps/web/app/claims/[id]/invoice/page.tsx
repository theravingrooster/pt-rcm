import Link from "next/link";
import { notFound } from "next/navigation";
import { getOperatorClaim, readPatientInvoice } from "@pt-rcm/db";
import { IdSchema } from "@pt-rcm/domain";
import { PatientInvoice } from "../../../_components/patient-invoice.js";
import { DataUnavailable } from "../../../_components/operator.js";
import { loadOperatorData } from "../../../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Synthetic patient invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = IdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const result = await loadOperatorData(async (db, org) => ({
    claim: await getOperatorClaim(db, org, parsed.data), invoice: await readPatientInvoice(db, org, parsed.data),
  }));
  if (!result.ok) return <DataUnavailable />;
  if (!result.data.claim || !result.data.invoice) notFound();
  const { claim, invoice } = result.data;
  return <>
    <p className="breadcrumb no-print"><Link href={`/claims/${parsed.data}`}>Claim</Link> / Printable invoice</p>
    <article className="panel invoice-sheet"><div className="section-heading"><div><p className="eyebrow">Synthetic invoice</p><h1>Patient balance</h1></div><span className="muted">Fixture remit · not for live billing</span></div>
      <div className="invoice-heading"><div><strong>{claim.patient.firstName} {claim.patient.lastName}</strong><p>Service date: {claim.encounter.dateOfService}</p></div><div><span className="muted">Claim</span><p className="mono">{claim.claim.id}</p><p>Status: {claim.claim.status}</p></div></div>
      <PatientInvoice invoice={invoice} />
    </article>
    <p className="no-print muted">Use your browser’s Print command to print or save this invoice.</p>
  </>;
}
