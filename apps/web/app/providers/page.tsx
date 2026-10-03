import { listConsoleProviders } from "@pt-rcm/db";
import { DataUnavailable, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Providers" };

export default async function ProvidersPage() {
  const result = await loadOperatorData(listConsoleProviders);
  if (!result.ok) return <DataUnavailable />;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Configuration</p><h1>Providers <span className="count">{result.data.length}</span></h1></div></div>
    <section className="panel"><div className="section-heading"><h2>Configured providers</h2><span className="muted">SYN Ortho PT</span></div>
      {result.data.length ? <TableFrame label="Providers"><table><thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">NPI</th><th scope="col">Taxonomy</th></tr></thead>
        <tbody>{result.data.map((provider) => <tr key={provider.id}><td>{provider.firstName} {provider.lastName}</td><td>{provider.role}</td><td className="mono">{provider.npi}</td><td className="mono">{provider.taxonomyCode}</td></tr>)}</tbody>
      </table></TableFrame> : <div className="empty-state"><p>No providers configured.</p><p className="muted">Run <code>pnpm db:seed</code> to load the synthetic providers.</p></div>}
    </section>
  </>;
}
