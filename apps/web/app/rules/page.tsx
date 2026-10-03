import Link from "next/link";
import { readRulesConsole } from "@pt-rcm/db";
import { Badge, DataUnavailable, EmptyState, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";
import { ruleGroups, ruleOutcomes } from "./rule-catalog.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Rules" };

export default async function RulesPage() {
  const result = await loadOperatorData(readRulesConsole);
  if (!result.ok) return <DataUnavailable />;
  const { activeVersion, shadowVersion, rules } = result.data;
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  return <>
    <div className="page-heading"><div><p className="eyebrow">Configuration / Rules</p><h1>Rules</h1>
      <p className="muted">Active pack {activeVersion ? `v${activeVersion}` : "not loaded"} · Shadow pack {shadowVersion ? `v${shadowVersion}` : "not staged"}. Shadow evaluations do not change claims.</p></div>
      <div className="actions"><div><button disabled type="button" title="Rules are versioned in code.">Create</button><p className="action-hint">Rules are versioned in code.</p></div></div>
    </div>
    {!rules.length ? <section className="panel"><EmptyState>No rule pack loaded. Run <code>pnpm db:seed</code> to load the synthetic rule pack.</EmptyState></section> : ruleGroups.map((section) =>
      <section className="panel" key={section.title}><div className="section-heading"><h2>{section.title}</h2></div>
        {section.steps.map((step) => {
          const entries = step.ids.map((id) => byId.get(id)).filter((rule) => rule !== undefined);
          return <div key={step.title}><div className="section-heading"><h3>{step.title}</h3><span className="muted">{entries.length} {entries.length === 1 ? "rule" : "rules"}</span></div>
            {entries.length ? <TableFrame label={`${step.title} rules`}><table><thead><tr><th scope="col">Rule ID</th><th scope="col">Description</th><th scope="col">Possible outcomes</th><th scope="col">Pack</th></tr></thead>
              <tbody>{entries.map((rule) => <tr key={rule.id}><th scope="row"><Link className="mono" href={`/rules/${rule.id}`}>{rule.id}</Link>{rule.id === "timed-code-cap" && !rule.active ? <span className="subtext">Shadow candidate</span> : null}</th>
                <td>{rule.description}</td><td>{ruleOutcomes[rule.id]?.map((outcome) => <span key={outcome} style={{ marginRight: 5 }}><Badge value={outcome} /></span>) ?? "—"}</td>
                <td className="nowrap">{rule.active ? <span className="badge good">ACTIVE</span> : null} {rule.shadow ? <span className="badge info">SHADOW</span> : null}</td></tr>)}</tbody></table></TableFrame>
              : <p className="inline-note muted">No code-backed rule in this step.</p>}
          </div>;
        })}
      </section>) }
  </>;
}
