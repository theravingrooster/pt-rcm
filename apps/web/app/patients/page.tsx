import Link from "next/link";
import { listOperatorPatients } from "@pt-rcm/db";
import { DataUnavailable, EmptyState, TableFrame } from "../_components/operator.js";
import { loadOperatorData } from "../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Patients" };

export default async function PatientsPage() {
  const result = await loadOperatorData(listOperatorPatients);
  if (!result.ok) return <DataUnavailable />;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Operations</p><h1>Patients <span className="count">{result.data.length}</span></h1>
      <p className="muted">Synthetic patient roster and saved coverage checks.</p></div></div>
    <section className="panel"><div className="section-heading"><h2>Patient roster</h2><span className="muted">Coverage and last eligibility check</span></div>
      {result.data.length ? <TableFrame label="Patients"><table><thead><tr><th scope="col">Patient</th><th scope="col">DOB</th><th scope="col">Coverage</th><th scope="col">Last eligibility check</th></tr></thead>
        <tbody>{result.data.map(({ patient, coverages }) => {
          const latest = coverages.map(({ coverage }) => coverage.checkedAt).filter((at): at is string => at !== null).sort().at(-1);
          return <tr key={patient.id}><td><Link href={`/patients/${patient.id}`}>{patient.firstName} {patient.lastName}</Link><span className="subtext mono">{patient.externalId}</span></td>
            <td className="nowrap"><time dateTime={patient.dob}>{patient.dob}</time></td>
            <td>{coverages.length ? coverages.map(({ coverage, payer }) => <div key={coverage.id}>{payer.name}<span className="subtext">{coverage.active ? "Active" : "Inactive"} coverage</span></div>) : <span className="muted">No coverage</span>}</td>
            <td>{latest ? <time dateTime={latest}>{latest}</time> : <span className="muted">Not checked</span>}</td></tr>;
        })}</tbody></table></TableFrame> : <EmptyState>No patients yet.</EmptyState>}
    </section>
  </>;
}
