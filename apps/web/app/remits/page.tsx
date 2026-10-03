import Link from "next/link";
import { listOperatorRemits } from "@pt-rcm/db";
import { RemitPostingResultSchema } from "@pt-rcm/domain";
import { ActionForm } from "../_components/action-form.js";
import { Badge, DataUnavailable, EmptyState, money, TableFrame } from "../_components/operator.js";
import { fixtureDisabledReason, loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Remits" };

export default async function RemitsPage() {
  const result = await loadOperatorData(listOperatorRemits);
  if (!result.ok) return <DataUnavailable />;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Operations</p><h1>Remits <span className="count">{result.data.length}</span></h1>
      <p className="muted">Posted fixture remittances. Select a claim to review its service lines and adjustment codes.</p></div>
      <ActionForm action="poll" endpoint="/api/remits/poll" label="Poll remits (fixture)" disabledReason={fixtureDisabledReason()} /></div>
    <section className="panel"><div className="section-heading"><h2>Remittance ledger</h2><span className="muted">Amounts in USD</span></div>
      {result.data.length ? <TableFrame label="Posted remits"><table><thead><tr><th scope="col">Received</th><th scope="col">ICN</th><th scope="col">Patient / DOS</th><th scope="col">Payer</th><th scope="col">Claim / match</th><th scope="col" className="number">Paid</th><th scope="col" className="number">Adjustments</th><th scope="col" className="number">Patient responsibility</th></tr></thead>
        <tbody>{result.data.map(({ remit, claim, encounter, patient, payer }) => {
          const posting = RemitPostingResultSchema.safeParse(remit.detailJson.result);
          return <tr key={remit.id}><td className="nowrap"><time dateTime={remit.receivedOn}>{remit.receivedOn}</time></td><td className="mono">{remit.payerIcn}</td>
            <td><Link href={`/patients/${patient.id}`}>{patient.firstName} {patient.lastName}</Link><span className="subtext">{encounter.dateOfService}</span></td><td>{payer.name}</td>
            <td><Link href={`/claims/${claim.id}`}>Claim v{claim.version}</Link><span className="subtext"><Badge value={claim.status} /> {posting.success ? posting.data.matched ? "Matched" : "Unmatched" : "Posting result unavailable"}</span></td>
            <td className="number">{money(remit.paidCents)}</td><td className="number">{money(remit.adjustmentCents)}</td><td className="number">{money(remit.patientResponsibilityCents)}</td></tr>;
        })}</tbody></table></TableFrame> : <EmptyState>No remits posted. Submit a scrubbed fixture claim and poll remits to populate this ledger.</EmptyState>}
    </section>
  </>;
}
