import { listConsoleServiceFacilities } from "@pt-rcm/db";
import { DataUnavailable, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Service facilities" };

export default async function ServiceFacilitiesPage() {
  const result = await loadOperatorData(listConsoleServiceFacilities);
  if (!result.ok) return <DataUnavailable />;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Configuration</p><h1>Service facilities <span className="count">{result.data.length}</span></h1></div></div>
    <section className="panel"><div className="section-heading"><h2>Places of service</h2><span className="muted">SYN Ortho PT</span></div>
      {result.data.length ? <TableFrame label="Service facilities"><table><thead><tr><th scope="col">Facility</th><th scope="col">NPI</th><th scope="col">Place of service</th><th scope="col">Address</th></tr></thead>
        <tbody>{result.data.map((facility) => <tr key={facility.id}><td>{facility.name}</td><td className="mono">{facility.npi}</td><td className="mono">{facility.placeOfServiceCode}</td>
          <td>{facility.address.line1}{facility.address.line2 ? `, ${facility.address.line2}` : ""}, {facility.address.city}, {facility.address.state} {facility.address.postalCode}</td></tr>)}</tbody>
      </table></TableFrame> : <div className="empty-state"><p>No service facilities configured.</p><p className="muted">Run <code>pnpm db:seed</code> to load the synthetic facility.</p></div>}
    </section>
  </>;
}
