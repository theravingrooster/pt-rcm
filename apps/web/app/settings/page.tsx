import { getConsoleOrganization } from "@pt-rcm/db";
import { DataUnavailable, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const result = await loadOperatorData(getConsoleOrganization);
  if (!result.ok) return <DataUnavailable />;
  const organization = result.data;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Configuration</p><h1>Settings</h1><p className="muted">Synthetic organization details</p></div></div>
    <section className="panel"><div className="section-heading"><h2>Organization</h2></div>
      {organization ? <TableFrame label="Organization settings"><table><tbody>
        <tr><th scope="row">Name</th><td>{organization.name}</td></tr>
        <tr><th scope="row">Billing NPI</th><td className="mono">{organization.billingNpi}</td></tr>
        <tr><th scope="row">Tax ID</th><td className="mono">{organization.taxId}</td></tr>
        <tr><th scope="row">Taxonomy</th><td className="mono">{organization.taxonomyCode}</td></tr>
        <tr><th scope="row">Address</th><td>{organization.address.line1}{organization.address.line2 ? `, ${organization.address.line2}` : ""}, {organization.address.city}, {organization.address.state} {organization.address.postalCode}</td></tr>
      </tbody></table></TableFrame> : <div className="empty-state"><p>No synthetic organization configured.</p><p className="muted">Run <code>pnpm db:seed</code> to load SYN Ortho PT.</p></div>}
    </section>
  </>;
}
