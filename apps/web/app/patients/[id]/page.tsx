import Link from "next/link";
import { notFound } from "next/navigation";
import { getOperatorPatient } from "@pt-rcm/db";
import { IdSchema } from "@pt-rcm/domain";
import { ActionForm } from "../../_components/action-form.js";
import { Badge, DataUnavailable, EmptyState, money, TableFrame } from "../../_components/operator.js";
import { fixtureDisabledReason, loadOperatorData } from "../../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Patient" };

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = IdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const result = await loadOperatorData((db, org) => getOperatorPatient(db, org, parsed.data));
  if (!result.ok) return <DataUnavailable />;
  if (!result.data) notFound();
  const { patient, coverages, encounters } = result.data;
  return <>
    <p className="breadcrumb"><Link href="/patients">Patients</Link> / {patient.externalId}</p>
    <div className="page-heading"><div><p className="eyebrow">Patient</p><h1>{patient.firstName} {patient.lastName}</h1><p className="muted mono">{patient.externalId}</p></div></div>
    <dl className="facts"><div><dt>Date of birth</dt><dd><time dateTime={patient.dob}>{patient.dob}</time></dd></div><div><dt>Sex</dt><dd>{patient.sex}</dd></div><div><dt>Coverage records</dt><dd>{coverages.length}</dd></div><div><dt>Encounters</dt><dd>{encounters.length}</dd></div></dl>
    <section className="panel"><div className="section-heading"><h2>Coverage and eligibility</h2><span className="muted">Last saved fixture check per coverage</span></div>
      {coverages.length ? <TableFrame label="Patient coverage"><table><thead><tr><th scope="col">Payer / plan</th><th scope="col">Member / group</th><th scope="col">Coverage</th><th scope="col">Last checked (UTC)</th><th scope="col">Eligibility / plan</th><th scope="col" className="number">Deductible remaining</th><th scope="col">Action</th></tr></thead>
        <tbody>{coverages.map(({ coverage, payer }) => <tr key={coverage.id}><td><strong>{payer.name}</strong><span className="subtext">{coverage.planName ?? "Plan not specified"}</span></td>
          <td className="mono">{coverage.memberId}<span className="subtext">{coverage.groupNumber ?? "No group number"}</span></td>
          <td><Badge value={coverage.active ? "ACTIVE" : "INACTIVE"} /></td>
          <td className="nowrap">{coverage.checkedAt ? <time dateTime={coverage.checkedAt}>{coverage.checkedAt}</time> : <span className="muted">Not checked</span>}</td>
          <td>{coverage.eligible === null ? <span className="muted">No result</span> : coverage.eligible ? "Eligible" : "Ineligible"}<span className="subtext">Plan {coverage.planActive === null ? "not checked" : coverage.planActive ? "active" : "inactive"}</span></td>
          <td className="number">{coverage.deductibleRemainingCents === null ? "—" : money(coverage.deductibleRemainingCents)}</td>
          <td><ActionForm action="eligibility" endpoint={`/api/coverage/${coverage.id}/eligibility`} label="Check eligibility (fixture)" disabledReason={fixtureDisabledReason()} /></td></tr>)}</tbody></table></TableFrame>
        : <EmptyState>No coverage recorded for this patient.</EmptyState>}
    </section>
    <section className="panel"><div className="section-heading"><h2>Encounters</h2><span className="muted">Most recent date of service first</span></div>
      {encounters.length ? <TableFrame label="Patient encounters"><table><thead><tr><th scope="col">Encounter</th><th scope="col">DOS</th><th scope="col">Status</th></tr></thead>
        <tbody>{encounters.map((encounter) => <tr key={encounter.id}><td><Link href={`/encounters/${encounter.id}`}>{encounter.externalId}</Link></td><td><time dateTime={encounter.dateOfService}>{encounter.dateOfService}</time></td><td><Badge value={encounter.status} /></td></tr>)}</tbody></table></TableFrame>
        : <EmptyState>No encounters recorded for this patient.</EmptyState>}
    </section>
  </>;
}
