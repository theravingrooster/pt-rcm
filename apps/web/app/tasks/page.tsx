import Link from "next/link";
import { listOperatorTasks } from "@pt-rcm/db";
import { ActionForm } from "../_components/action-form.js";
import { Badge, DataUnavailable, EmptyState, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Open tasks" };

export default async function TasksPage() {
  const result = await loadOperatorData(listOperatorTasks);
  if (!result.ok) return <DataUnavailable />;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Work queue</p><h1>Open tasks <span className="count">{result.data.length}</span></h1><p className="muted">Completing a task records an audit event.</p></div><Link href="/">Back to encounters</Link></div>
    <section className="panel">{result.data.length ? <TableFrame label="Open tasks"><table><thead><tr><th scope="col">Task / reason</th><th scope="col">Patient / DOS</th><th scope="col">Claim</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
      <tbody>{result.data.map(({ task, claim, encounter, patient }) => <tr key={task.id}><td><strong className="mono">{task.kind}</strong><span className="subtext task-reason">{task.reason}</span></td>
        <td><Link href={`/encounters/${encounter.id}`}>{patient.firstName} {patient.lastName}</Link><span className="subtext">{encounter.dateOfService}</span></td>
        <td><Link href={`/claims/${claim.id}`}>v{claim.version} · {claim.status}</Link></td><td>{task.owner}</td><td><Badge value={task.status} /></td>
        <td><ActionForm action="done" endpoint={`/api/tasks/${task.id}/done`} label="Mark done" /></td></tr>)}</tbody></table></TableFrame> : <EmptyState>No open tasks. Scrub a demo encounter or poll its fixture remit to create work items.</EmptyState>}</section>
  </>;
}
