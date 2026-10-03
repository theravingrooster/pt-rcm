import Link from "next/link";
import { notFound } from "next/navigation";
import { getOperatorClaim } from "@pt-rcm/db";
import { getCarcFixture, IdSchema, RemitAdjustmentSchema, RemitPostingResultSchema } from "@pt-rcm/domain";
import { ActionForm } from "../../_components/action-form.js";
import { Badge, ClaimJson, DataUnavailable, EmptyState, money, TableFrame } from "../../_components/operator.js";
import { fixtureDisabledReason, loadOperatorData } from "../../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Claim" };

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = IdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const result = await loadOperatorData((db, org) => getOperatorClaim(db, org, parsed.data));
  if (!result.ok) return <DataUnavailable />;
  if (!result.data) notFound();
  const { claim, encounter, patient, payer, lines, remits, remitLines, document, icn } = result.data;
  return <>
    <p className="breadcrumb"><Link href="/claims">Claims</Link> / <Link href={`/encounters/${encounter.id}`}>{encounter.externalId}</Link> / Claim v{claim.version}</p>
    <div className="page-heading"><div><p className="eyebrow">Claim v{claim.version}</p><h1>{patient.firstName} {patient.lastName}</h1><p className="muted mono">{claim.id}</p></div>
      <div className="actions"><ActionForm action="submit" endpoint={`/api/claims/${claim.id}/submit`} label="Submit claim (fixture)" primary disabledReason={fixtureDisabledReason() ?? (claim.status === "SCRUBBED" ? undefined : "A SCRUBBED claim is required.")} />
        <ActionForm action="poll" endpoint="/api/remits/poll" label="Poll remits (fixture)" disabledReason={fixtureDisabledReason()} /></div>
    </div>
    <dl className="facts"><div><dt>Status</dt><dd><Badge value={claim.status} /></dd></div><div><dt>Date of service</dt><dd>{encounter.dateOfService}</dd></div><div><dt>Payer</dt><dd>{payer.name}</dd></div>
      <div><dt>Claim charge</dt><dd>{money(claim.totalChargeCents)}</dd></div><div className="wide"><dt>ICN</dt><dd className="mono">{icn ?? "Not submitted"}</dd></div></dl>
    <section className="panel"><div className="section-heading"><h2>Claim lines</h2><span className="muted">Stored units and modifiers</span></div>
      {lines.length ? <TableFrame label="Claim lines"><table><thead><tr><th scope="col">CPT</th><th scope="col">Modifiers</th><th scope="col" className="number">Units</th><th scope="col" className="number">Minutes</th><th scope="col">Diagnosis pointers</th><th scope="col" className="number">Charge</th></tr></thead>
        <tbody>{lines.map((line) => <tr key={line.id}><td className="mono">{line.cptCode}</td><td className="mono">{line.modifiers.join(", ") || "—"}</td><td className="number">{line.units}</td><td className="number">{line.minutes}</td><td>{line.diagnosisPointers.join(", ")}</td><td className="number">{money(line.chargeCents)}</td></tr>)}</tbody></table></TableFrame>
        : <EmptyState>No billable claim lines. Review the encounter findings.</EmptyState>}
    </section>
    <section className="panel"><div className="section-heading"><h2>Remittances</h2><span className="muted">Posted amounts; adjustments exclude patient responsibility</span></div>
      {remits.length ? remits.map((remit) => {
        const posting = RemitPostingResultSchema.safeParse(remit.detailJson.result);
        const matchedLines = remitLines.filter((line) => line.remitLine.remitId === remit.id);
        return <article className="remit" key={remit.id}><div className="remit-heading"><h3>Received {remit.receivedOn}</h3><span className="mono muted">{remit.payerIcn}</span></div>
          <p className="remit-totals">Paid <strong>{money(remit.paidCents)}</strong> · Adjustments <strong>{money(remit.adjustmentCents)}</strong> · Patient responsibility <strong>{money(remit.patientResponsibilityCents)}</strong></p>
          {posting.success ? posting.data.flags.map((flag, index) => <p className="inline-note" key={index}><Badge value={flag.outcome} /> <strong>{flag.code}</strong> — {flag.message}</p>) : null}
          {matchedLines.length ? <TableFrame label={`Remit lines received ${remit.receivedOn}`}><table><thead><tr><th scope="col">CPT / units</th><th scope="col" className="number">Paid</th><th scope="col" className="number">Adjustments</th><th scope="col" className="number">CO write-off</th><th scope="col" className="number">Patient</th><th scope="col">CARC / plain English</th><th scope="col">RARC</th></tr></thead>
            <tbody>{matchedLines.map(({ remitLine, claimLine }) => {
              const adjustments = RemitAdjustmentSchema.array().safeParse(remitLine.detailJson.adjustments);
              const codes = adjustments.success && adjustments.data.length ? adjustments.data : remitLine.carc ? [{ carc: remitLine.carc, amountCents: null }] : [];
              return <tr key={remitLine.id}><td className="mono">{claimLine.cptCode}<span className="subtext">{claimLine.units} units</span></td><td className="number">{money(remitLine.paidCents)}</td><td className="number">{money(remitLine.adjustmentCents)}</td><td className="number">{money(remitLine.contractualWriteOffCents)}</td><td className="number">{money(remitLine.patientResponsibilityCents)}</td>
                <td className="carc-cell">{codes.length ? codes.map((adjustment, index) => <div key={index}><strong className="mono">{adjustment.carc}{adjustment.amountCents !== null ? ` · ${money(adjustment.amountCents)}` : ""}</strong><span className="subtext">{getCarcFixture(adjustment.carc)?.meaning ?? "No plain-English description in the local CARC fixture."}</span></div>) : <span className="muted">No adjustment code</span>}</td><td>{remitLine.rarc ?? "—"}</td></tr>;
            })}</tbody></table></TableFrame> : <EmptyState>REMIT_UNMATCHED: no service lines were matched. Review the open remit task; the original receipt is retained.</EmptyState>}
        </article>;
      }) : <EmptyState>No remits posted. Submit a scrubbed claim using the fixture, then choose Poll remits (fixture).</EmptyState>}
    </section>
    <p><Link href="/tasks">Review open tasks</Link></p>
    <ClaimJson document={document} />
  </>;
}
