import Link from "next/link";
import { notFound } from "next/navigation";
import { getOperatorChart } from "@pt-rcm/db";
import { getCptFixture, IdSchema } from "@pt-rcm/domain";
import { Badge, DataUnavailable, EmptyState, TableFrame } from "../../_components/operator.js";
import { loadOperatorData } from "../../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Locked chart" };

export default async function ChartPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = IdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const result = await loadOperatorData((db, org) => getOperatorChart(db, org, parsed.data));
  if (!result.ok) return <DataUnavailable />;
  if (!result.data) notFound();
  const { encounter, patient, provider, noteId, entries, allocation, latestClaim } = result.data;
  return <>
    <p className="breadcrumb"><Link href="/charts">Charts</Link> / <span className="mono">{noteId}</span></p>
    <div className="page-heading"><div><p className="eyebrow">Operations / Charts</p><h1>Locked PT note</h1><p className="muted mono">{noteId}</p></div>
      <Link href={`/encounters/${encounter.id}`}>View encounter</Link></div>
    <dl className="facts"><div><dt>Patient external ID</dt><dd className="mono">{patient.externalId}</dd></div>
      <div><dt>Date of service</dt><dd><time dateTime={encounter.dateOfService}>{encounter.dateOfService}</time></dd></div>
      <div><dt>Rendering NPI</dt><dd className="mono">{provider.npi}</dd></div>
      <div><dt>Linked status</dt><dd><Badge value={latestClaim?.status ?? "DRAFT"} /></dd></div>
      <div><dt>Claim</dt><dd>{latestClaim ? <Link href={`/claims/${latestClaim.id}`}>v{latestClaim.version}</Link> : "Not created"}</dd></div>
    </dl>
    <section className="panel"><div className="section-heading"><h2>Recorded timed entries</h2><span className="muted">Source note timing, saved on lock</span></div>
      {entries.length ? <TableFrame label="Locked note entries"><table><thead><tr><th scope="col">CPT / service</th><th scope="col">Start (UTC)</th><th scope="col">Stop (UTC)</th><th scope="col" className="number">Computed minutes</th></tr></thead>
        <tbody>{entries.map((entry) => <tr key={entry.id}><td><span className="mono">{entry.cptCode}</span><span className="subtext">{getCptFixture(entry.cptCode)?.name ?? "Fixture service"}</span></td>
          <td className="mono nowrap">{entry.timing ? <time dateTime={entry.timing.startTime}>{entry.timing.startTime}</time> : <span className="muted">Time unavailable</span>}</td>
          <td className="mono nowrap">{entry.timing ? <time dateTime={entry.timing.stopTime}>{entry.timing.stopTime}</time> : <span className="muted">Time unavailable</span>}</td>
          <td className="number">{entry.minutes}</td></tr>)}</tbody></table></TableFrame> : <EmptyState>No timed entries recorded.</EmptyState>}
    </section>
    <section className="panel"><div className="section-heading"><h2>Allocator preview</h2><span className="muted">Same payer allocation as the encounter</span></div>
      <div className="allocation-totals"><span><strong>{allocation.totalTimedMinutes}</strong> timed minutes</span><span><strong>{allocation.totalUnits}</strong> units</span><span><strong>{allocation.unusedMinutes}</strong> unused minutes</span></div>
      {allocation.lines.length ? <TableFrame label="Chart allocator preview"><table><thead><tr><th scope="col">CPT</th><th scope="col" className="number">Minutes</th><th scope="col" className="number">Units</th><th scope="col" className="number">Remainder</th></tr></thead>
        <tbody>{allocation.lines.map((line, index) => <tr key={entries[index]!.id}><td className="mono">{line.cptCode}</td><td className="number">{line.minutes}</td><td className="number">{line.units}</td><td className="number">{line.remainderMinutes}</td></tr>)}</tbody></table></TableFrame> : <EmptyState>No lines to allocate.</EmptyState>}
      {allocation.flags.map((flag) => <p className="inline-note" key={flag.lineIndex}><Badge value={flag.outcome} /> {flag.cptCode}: {flag.reason}</p>)}
    </section>
  </>;
}
