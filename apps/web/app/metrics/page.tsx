import { readOperatorMetrics } from "@pt-rcm/db";
import { TIMED_UNIT_FIXTURE_FEE_CENTS } from "@pt-rcm/domain";
import { DataUnavailable, EmptyState, money, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Metrics" };

const percent = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-US", {
  style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1,
}).format(value);

export default async function MetricsPage() {
  const result = await loadOperatorData(readOperatorMetrics);
  if (!result.ok) return <DataUnavailable />;
  const m = result.data;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Synthetic operations</p><h1>Metrics</h1>
      <p className="muted">Latest claim per encounter. Amounts use the local fixture fee schedule.</p></div></div>
    <section className="panel"><div className="section-heading"><h2>Claim and collection measures</h2><span className="muted">{m.claimCount} claims · {m.scrubbedEncounterCount} scrubbed encounters</span></div>
      {m.claimCount ? <TableFrame label="Operator metrics"><table><thead><tr><th scope="col">Measure</th><th scope="col" className="number">Value</th><th scope="col">Calculation</th></tr></thead>
        <tbody>
          <tr><th scope="row">Touchless rate</th><td className="number">{percent(m.touchlessRate)}</td><td>{m.touchlessCount} paid or patient-balance claims with no operator task ever opened / {m.claimCount} claims</td></tr>
          <tr><th scope="row">Denial rate</th><td className="number">{percent(m.denialRate)}</td><td>{m.deniedCount} currently denied / {m.submittedCount} ever submitted claims</td></tr>
          <tr><th scope="row">Units left on table</th><td className="number">{m.unitsLeftOnTable}</td><td>Allocated timed units minus saved billed timed units, summed over scrubbed encounters; shortages only</td></tr>
          <tr><th scope="row">Cents left on table</th><td className="number">{money(m.centsLeftOnTable)}</td><td>{m.unitsLeftOnTable} units × {money(TIMED_UNIT_FIXTURE_FEE_CENTS)} fixture timed-unit fee</td></tr>
          <tr><th scope="row">Net collection rate</th><td className="number">{percent(m.netCollectionRate)}</td><td>{money(m.paidCents)} payer paid / ({money(m.paidCents)} paid + {money(m.contractualWriteOffCents)} CO write-offs + {money(m.remainingDenialBalanceCents)} remaining denial balance). Patient responsibility is excluded.</td></tr>
        </tbody></table></TableFrame> : <EmptyState>No claims yet. Seed and scrub the synthetic encounters to populate these measures.</EmptyState>}
    </section>
  </>;
}
