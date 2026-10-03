import Link from "next/link";
import { notFound } from "next/navigation";
import { readRuleHistory } from "@pt-rcm/db";
import { Badge, DataUnavailable, EmptyState, TableFrame } from "../../_components/operator.js";
import { loadOperatorData } from "../../_lib/server.js";
import { ruleOutcomes } from "../rule-catalog.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Rule activity" };

export default async function RulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadOperatorData((db, org) => readRuleHistory(db, org, id));
  if (!result.ok) return <DataUnavailable />;
  if (!result.data) notFound();
  const { rule, fires } = result.data;
  return <>
    <p className="breadcrumb"><Link href="/rules">Rules</Link> / <span className="mono">{rule.id}</span></p>
    <div className="page-heading"><div><p className="eyebrow">Code-backed policy · v{rule.version}</p><h1 className="mono">{rule.id}</h1><p className="muted">{rule.description}</p></div></div>
    <dl className="facts"><div><dt>Current packs</dt><dd>{rule.active ? <span className="badge good">ACTIVE</span> : null} {rule.shadow ? <span className="badge info">SHADOW</span> : null}</dd></div>
      <div className="wide"><dt>Possible outcomes</dt><dd>{ruleOutcomes[rule.id]?.map((outcome) => <span key={outcome} style={{ marginRight: 5 }}><Badge value={outcome} /></span>) ?? "—"}</dd></div></dl>
    <section className="panel"><div className="section-heading"><h2>Last RuleFire rows</h2><span className="muted">Latest 25, scoped to SYN Ortho PT · active and shadow runs</span></div>
      {fires.length ? <TableFrame label={`Recent ${rule.id} findings`}><table><thead><tr><th scope="col">Evaluated at (UTC)</th><th scope="col">Run / pack</th><th scope="col">Claim</th><th scope="col">Patient / DOS</th><th scope="col">Outcome</th><th scope="col">Finding</th></tr></thead>
        <tbody>{fires.map(({ fire, pack, encounter, claim, patient }) => <tr key={fire.id}><td className="nowrap mono">{fire.createdAt.replace("T", " ").replace("Z", "")}</td>
          <td className="nowrap"><span className={`badge ${fire.shadow ? "info" : "good"}`}>{fire.shadow ? "SHADOW" : "ACTIVE"}</span><span className="subtext">{pack ? `v${pack.version}` : `Rule v${fire.ruleVersion}`}</span></td>
          <td><Link href={`/claims/${claim.id}`} className="mono">v{claim.version} · {claim.id.slice(0, 8)}</Link></td>
          <td><Link href={`/encounters/${encounter.id}`}>{patient.firstName} {patient.lastName}</Link><span className="subtext mono">{encounter.dateOfService}</span></td>
          <td><Badge value={fire.outcome} /></td>
          <td>{typeof fire.detailJson.code === "string" ? <strong className="mono">{fire.detailJson.code}</strong> : null}
            <span className="subtext">{typeof fire.detailJson.message === "string" ? fire.detailJson.message : "Passed"}</span></td></tr>)}</tbody></table></TableFrame>
        : <EmptyState>No findings for this rule yet. Run <code>pnpm seed:demo</code>, then scrub an encounter and run the shadow scrub to see both modes.</EmptyState>}
    </section>
  </>;
}
