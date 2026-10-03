import { listConsolePayers } from "@pt-rcm/db";
import { DataUnavailable, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Payers" };

export default async function PayersPage() {
  const result = await loadOperatorData((db) => listConsolePayers(db));
  if (!result.ok) return <DataUnavailable />;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Configuration</p><h1>Payers <span className="count">{result.data.length}</span></h1>
      <p className="muted">Configured fixture payers. The current payer table is shared across synthetic organizations.</p></div></div>
    <section className="panel"><div className="section-heading"><h2>Payer policy</h2></div>
      {result.data.length ? <TableFrame label="Payers"><table><thead><tr><th scope="col">Payer</th><th scope="col">Type</th><th scope="col">Unit rule</th><th scope="col">GP modifier</th><th scope="col">Authorization</th></tr></thead>
        <tbody>{result.data.map((payer) => <tr key={payer.id}><td>{payer.name}</td><td>{payer.payerType}</td><td className="mono">{payer.unitRule}</td><td>{payer.requiresGpModifier ? "Required" : "Not required"}</td><td>{payer.authRequired ? "Required" : "Not required"}</td></tr>)}</tbody>
      </table></TableFrame> : <div className="empty-state"><p>No payers configured.</p><p className="muted">Run <code>pnpm db:seed</code> to load the synthetic payers.</p></div>}
    </section>
  </>;
}
