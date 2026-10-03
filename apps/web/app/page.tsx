import Link from "next/link";
import { listOperatorEncounters, listOperatorTasks, readOperatorMetrics } from "@pt-rcm/db";
import { Badge, DataUnavailable, EmptyState, money, TableFrame } from "./_components/operator.js";
import { loadOperatorData } from "./_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function HomePage() {
  const result = await loadOperatorData(async (db, org) => {
    const encounters = await listOperatorEncounters(db, org);
    const tasks = await listOperatorTasks(db, org);
    const metrics = await readOperatorMetrics(db, org);
    return { encounters, tasks: tasks.filter(({ task }) => task.owner === "OPERATOR"), metrics };
  });
  if (!result.ok) return <DataUnavailable />;
  const { encounters, tasks, metrics } = result.data;
  const blocked = encounters.filter(({ claim }) => claim?.status === "BLOCKED").length;
  const awaitingRemit = encounters.filter(({ claim }) => claim && ["SUBMITTED", "ACCEPTED"].includes(claim.status)).length;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Operations / Home</p><h1>Work overview</h1><p className="muted">Latest claim per encounter and open work for SYN Ortho PT.</p></div></div>
    <div className="stat-grid" aria-label="Operations counts">
      <div className="stat-card"><span className="eyebrow">Claims blocked</span><strong>{blocked}</strong><Link href="/claims">Review claims</Link></div>
      <div className="stat-card"><span className="eyebrow">Claims awaiting remit</span><strong>{awaitingRemit}</strong><Link href="/remits">Review remits</Link></div>
      <div className="stat-card"><span className="eyebrow">Cents left on the table</span><strong>{money(metrics.centsLeftOnTable)}</strong><Link href="/reports">View calculation</Link></div>
    </div>
    <section className="panel"><div className="section-heading"><h2>Open tasks assigned to OPERATOR <span className="count">{tasks.length}</span></h2><Link href="/tasks">All open tasks</Link></div>
      {tasks.length ? <TableFrame label="Operator tasks"><table><thead><tr><th scope="col">Task</th><th scope="col">Patient / DOS</th><th scope="col">Claim status</th><th scope="col">Reason</th></tr></thead><tbody>
        {tasks.map(({ task, claim, encounter, patient }) => <tr key={task.id}><td className="mono">{task.kind}</td><td><Link href={`/encounters/${encounter.id}`}>{patient.firstName} {patient.lastName}</Link><span className="subtext">{encounter.dateOfService}</span></td><td><Link href={`/claims/${claim.id}`}><Badge value={claim.status} /></Link></td><td className="task-reason">{task.reason}</td></tr>)}
      </tbody></table></TableFrame> : <EmptyState>No open OPERATOR tasks. Scrub a synthetic encounter or poll a fixture remit to create work.</EmptyState>}
    </section>
  </>;
}
