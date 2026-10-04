import Link from "next/link";
import { listOperatorCharts } from "@pt-rcm/db";
import { Badge, DataUnavailable, EmptyState, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Charts" };

export default async function ChartsPage() {
  const result = await loadOperatorData(listOperatorCharts);
  if (!result.ok) return <DataUnavailable />;
  const rows = result.data;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Operations / Charts</p><h1>Charts <span className="count">{rows.length}</span></h1>
      <p className="muted">Locked synthetic PT notes and their linked encounters.</p></div></div>
    <section className="panel"><div className="section-heading"><h2>Locked notes</h2><span className="muted">Raw time and billable union from saved intervals</span></div>
      {rows.length ? <TableFrame label="Locked PT notes"><table><thead><tr><th scope="col">Note ID</th><th scope="col">Patient external ID</th><th scope="col">DOS</th><th scope="col">CPT entries</th><th scope="col" className="number">Raw minutes</th><th scope="col" className="number">Billable union</th><th scope="col">Finding</th><th scope="col">Linked status</th><th scope="col" className="number">Units</th></tr></thead>
        <tbody>{rows.map(({ encounter, patient, noteId, entries, rawMinutes, billableUnionMinutes, overlappingMinutes, units, claim }) => <tr key={encounter.id}>
          <td className="mono"><Link href={`/charts/${encounter.id}`}>{noteId}</Link></td>
          <td className="mono">{patient.externalId}</td>
          <td className="nowrap"><time dateTime={encounter.dateOfService}>{encounter.dateOfService}</time></td>
          <td>{entries.length ? entries.map((line) => <span key={line.id} className="subtext mono">{line.cptCode} · {line.untimed ? "untimed" : `${line.rawMinutes} min${line.timing ? "" : " (time unavailable)"}`}</span>) : <span className="muted">No entries</span>}</td>
          <td className="number">{rawMinutes}</td>
          <td className="number">{billableUnionMinutes}</td>
          <td>{overlappingMinutes > 0 ? <><Badge value="FLAG" /> <span className="mono">OVERLAPPING_MINUTES</span></> : <span className="muted">—</span>}</td>
          <td><Badge value={claim?.status ?? "DRAFT"} />{claim ? <span className="subtext mono">v{claim.version}</span> : null}</td>
          <td className="number">{units}</td>
        </tr>)}</tbody></table></TableFrame> : <EmptyState>No locked notes yet.</EmptyState>}
    </section>
  </>;
}
