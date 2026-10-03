import Link from "next/link";
import { listConsoleClaims } from "@pt-rcm/db";
import { Badge, DataUnavailable, EmptyState, money, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Claims" };

export default async function ClaimsPage() {
  const result = await loadOperatorData(listConsoleClaims);
  if (!result.ok) return <DataUnavailable />;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Operations / Claims</p><h1>Claims <span className="count">{result.data.length}</span></h1><p className="muted">All saved claim versions. Open a claim to review its document, submission, and remit.</p></div><Link href="/queues">Encounter queue</Link></div>
    <section className="panel"><div className="section-heading"><h2>Claim register</h2></div>
      {result.data.length ? <TableFrame label="Claim register"><table><thead><tr><th scope="col">Claim / version</th><th scope="col">Patient / encounter</th><th scope="col">DOS</th><th scope="col">Payer</th><th scope="col">Status</th><th scope="col" className="number">Charge</th></tr></thead>
        <tbody>{result.data.map(({ claim, encounter, patient, payer }) => <tr key={claim.id}>
          <td><Link href={`/claims/${claim.id}`}>Claim v{claim.version}</Link><span className="subtext mono">{claim.id}</span></td>
          <td><Link href={`/encounters/${encounter.id}`}>{patient.firstName} {patient.lastName}</Link><span className="subtext mono">{encounter.externalId}</span></td>
          <td className="nowrap">{encounter.dateOfService}</td><td>{payer.name}</td><td><Badge value={claim.status} /></td><td className="number">{money(claim.totalChargeCents)}</td>
        </tr>)}</tbody></table></TableFrame> : <EmptyState>No claims yet. Seed the shoulder demo, then scrub an encounter in Queues.</EmptyState>}
    </section>
  </>;
}
