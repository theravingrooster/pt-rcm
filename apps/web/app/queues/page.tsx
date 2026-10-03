import Link from "next/link";
import { listOperatorEncounters } from "@pt-rcm/db";
import { ActionForm } from "../_components/action-form.js";
import { Badge, DataUnavailable, EmptyState, TableFrame } from "../_components/operator.js";
import { fixtureDisabledReason, loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Queues" };

export default async function QueuesPage() {
  const result = await loadOperatorData(listOperatorEncounters);
  if (!result.ok) return <DataUnavailable />;
  const rows = result.data;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Operations / Queues</p><h1>Encounter queue <span className="count">{rows.length}</span></h1><p className="muted">Recorded visits, latest claims, and scrub blocks.</p></div>
      <ActionForm action="poll" endpoint="/api/remits/poll" label="Poll remits (fixture)" disabledReason={fixtureDisabledReason()} />
    </div>
    <section className="panel"><div className="section-heading"><h2>All encounters</h2><span className="muted">Latest claim status and units, when available</span></div>
      {rows.length ? <TableFrame label="Encounters"><table><caption className="sr-only">Encounters and their latest claims</caption>
        <thead><tr><th scope="col">Patient / encounter</th><th scope="col">DOS</th><th scope="col">Status</th><th scope="col" className="number">Units</th><th scope="col" className="number">Blocks</th><th scope="col">Claim</th></tr></thead>
        <tbody>{rows.map(({ encounter, patient, claim, units, unitsSource, blocks }) => <tr key={encounter.id}>
          <td><Link href={`/encounters/${encounter.id}`}>{patient.firstName} {patient.lastName}</Link><span className="subtext mono">{encounter.externalId}</span></td>
          <td className="nowrap"><time dateTime={encounter.dateOfService}>{encounter.dateOfService}</time></td>
          <td><Badge value={claim?.status ?? encounter.status} />{claim ? <span className="subtext">Encounter: {encounter.status}</span> : null}</td>
          <td className="number">{units}<span className="subtext">{unitsSource}</span></td>
          <td className="number">{claim ? <span className={blocks ? "block-count" : "muted"}>{blocks}</span> : <span className="muted">Not scrubbed</span>}</td>
          <td>{claim ? <Link href={`/claims/${claim.id}`}>View v{claim.version}</Link> : <span className="muted">No claim</span>}</td>
        </tr>)}</tbody></table></TableFrame> : <EmptyState>No encounters yet.</EmptyState>}
    </section>
  </>;
}
