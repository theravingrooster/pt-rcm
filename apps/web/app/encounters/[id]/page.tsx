import Link from "next/link";
import { notFound } from "next/navigation";
import { getOperatorEncounter } from "@pt-rcm/db";
import { getCptFixture, IdSchema } from "@pt-rcm/domain";
import { ActionForm } from "../../_components/action-form.js";
import { Badge, ClaimJson, DataUnavailable, EmptyState, TableFrame } from "../../_components/operator.js";
import { fixtureDisabledReason, loadOperatorData } from "../../_lib/server.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Encounter" };

export default async function EncounterPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = IdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const result = await loadOperatorData((db, org) => getOperatorEncounter(db, org, parsed.data));
  if (!result.ok) return <DataUnavailable />;
  if (!result.data) notFound();
  const { encounter, patient, provider, facility, minuteLines, diagnoses, latestClaim, claims, allocation, findings, rulePacks, document } = result.data;
  const canScrub = !latestClaim || ["DRAFT", "BLOCKED", "SCRUBBED", "DENIED"].includes(latestClaim.status);
  const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))].sort();
  const activeFindings = new Map(findings.filter((finding) => !finding.shadow).map((finding) => [finding.ruleId, finding]));
  const shadowFindings = new Map(findings.filter((finding) => finding.shadow).map((finding) => [finding.ruleId, finding]));
  const canApplyModifier = Boolean(latestClaim && ["DRAFT", "BLOCKED", "SCRUBBED"].includes(latestClaim.status));
  const suggestedModifier = (finding: (typeof findings)[number] | undefined) => {
    if (finding?.ruleId !== "distinct-procedure" || finding.outcome !== "FLAG" || finding.detailJson.code !== "MISSING_59") return null;
    const detail = finding.detailJson;
    if (detail.suggestedModifier !== "59" || !Array.isArray(detail.cptCodes) || detail.cptCodes.length !== 2
      || !detail.cptCodes.every((code) => typeof code === "string")) return null;
    return detail.cptCodes as [string, string];
  };
  const displayFinding = (finding: (typeof findings)[number] | undefined) => {
    if (!finding) return <span className="muted">Not run</span>;
    const suggestion = suggestedModifier(finding);
    return <>
      <Badge value={finding.outcome} /> {typeof finding.detailJson.code === "string" ? <strong className="mono">{finding.detailJson.code}</strong> : null}
      <span className="subtext">{String(finding.detailJson.message ?? finding.detailJson.description ?? "Passed")}</span>
      {suggestion ? <span className="subtext">Suggested modifier <strong className="mono">59</strong> on CPT <span className="mono">{suggestion[1]}</span> for the <span className="mono">{suggestion.join(" / ")}</span> pair</span> : null}
      <span className="subtext mono">Rule v{finding.ruleVersion} · {finding.createdAt.replace("T", " ").replace("Z", "")} UTC</span>
    </>;
  };
  return <>
    <p className="breadcrumb"><Link href="/queues">Queues</Link> / <span>{encounter.externalId}</span></p>
    <div className="page-heading"><div><p className="eyebrow">Encounter</p><h1>{patient.firstName} {patient.lastName}</h1><p className="muted mono">{encounter.externalId}</p></div>
      <div className="actions"><ActionForm action="scrub" endpoint={`/api/encounters/${encounter.id}/scrub`} label="Scrub encounter" primary disabledReason={canScrub ? undefined : `Scrub unavailable while the claim is ${latestClaim!.status}.`} />
        <ActionForm action="shadow" endpoint={`/api/encounters/${encounter.id}/scrub?mode=shadow`} label="Run shadow scrub" disabledReason={!latestClaim ? "Scrub the encounter first to create a claim." : rulePacks.hasShadow ? undefined : "No shadow pack is staged."} />
        {latestClaim ? <ActionForm action="submit" endpoint={`/api/claims/${latestClaim.id}/submit`} label="Submit claim (fixture)" disabledReason={fixtureDisabledReason() ?? (latestClaim.status === "SCRUBBED" ? undefined : "A SCRUBBED claim is required.")} /> : null}</div>
    </div>
    <dl className="facts"><div><dt>Date of service</dt><dd>{encounter.dateOfService}</dd></div><div><dt>Encounter status</dt><dd><Badge value={encounter.status} /></dd></div>
      <div><dt>Latest claim</dt><dd>{latestClaim ? <Link href={`/claims/${latestClaim.id}`}>v{latestClaim.version} · {latestClaim.status}</Link> : "Not created"}</dd></div>
      <div><dt>Rendering provider</dt><dd>{provider.firstName} {provider.lastName}<span className="subtext mono">NPI {provider.npi}</span></dd></div>
      <div><dt>Facility / POS</dt><dd>{facility.name} / {facility.placeOfServiceCode}</dd></div><div><dt>Diagnoses / pointers</dt><dd>{diagnoses.map((diagnosis) => `${diagnosis.icd10} [${diagnosis.pointer}]`).join(", ") || "None recorded"}</dd></div>
    </dl>
    <div className="two-columns">
      <section className="panel"><div className="section-heading"><h2>Recorded minute lines</h2><span className="muted">Source encounter</span></div>
        {minuteLines.length ? <TableFrame label="Recorded minute lines"><table><thead><tr><th scope="col">CPT / service</th><th scope="col">Timing</th><th scope="col" className="number">Minutes</th></tr></thead>
          <tbody>{minuteLines.map((line) => <tr key={line.id}><td><span className="mono">{line.cptCode}</span><span className="subtext">{getCptFixture(line.cptCode)?.name ?? "Fixture service"}</span>{line.notes ? <span className="subtext">{line.notes}</span> : null}</td><td>{line.timed ? "Timed" : "Untimed"}</td><td className="number">{line.minutes}</td></tr>)}</tbody></table></TableFrame> : <EmptyState>No minute lines recorded.</EmptyState>}
      </section>
      <section className="panel"><div className="section-heading"><h2>Allocator output</h2><span className="muted">Current encounter preview</span></div>
        <div className="allocation-totals"><span><strong>{allocation.totalTimedMinutes}</strong> timed minutes</span><span><strong>{allocation.totalUnits}</strong> units</span><span><strong>{allocation.unusedMinutes}</strong> unused minutes</span></div>
        {allocation.lines.length ? <TableFrame label="Allocator output"><table><thead><tr><th scope="col">CPT</th><th scope="col" className="number">Minutes</th><th scope="col" className="number">Units</th><th scope="col" className="number">Remainder</th></tr></thead>
          <tbody>{allocation.lines.map((line, index) => <tr key={minuteLines[index]!.id}><td className="mono">{line.cptCode}</td><td className="number">{line.minutes}</td><td className="number">{line.units}</td><td className="number">{line.remainderMinutes}</td></tr>)}</tbody></table></TableFrame> : <EmptyState>No lines to allocate.</EmptyState>}
        {allocation.flags.map((flag) => <p className="inline-note" key={flag.lineIndex}><Badge value={flag.outcome} /> {flag.cptCode}: {flag.reason}</p>)}
      </section>
    </div>
    <section className="panel"><div className="section-heading"><h2>Rule comparison</h2><span className="muted">Latest active and shadow findings per rule. Shadow results do not change the claim.</span></div>
      {ruleIds.length ? <TableFrame label="Active and shadow rule findings"><table><caption className="sr-only">Latest active and shadow rule results by rule ID</caption>
        <thead><tr><th scope="col">Rule</th><th scope="col">Active finding{rulePacks.active ? <span className="subtext">{rulePacks.active}</span> : null}</th><th scope="col">Shadow finding (simulation){rulePacks.shadow ? <span className="subtext">{rulePacks.shadow}</span> : null}</th></tr></thead>
        <tbody>{ruleIds.map((ruleId) => {
          const active = activeFindings.get(ruleId);
          return <tr key={ruleId}><th scope="row" className="mono">{ruleId}</th><td>{displayFinding(active)}
            {latestClaim && canApplyModifier && suggestedModifier(active) ? <div className="suggestion-action"><ActionForm action="modifier" endpoint={`/api/claims/${latestClaim.id}/modifier`} label="apply suggested modifier" /></div> : null}
          </td><td>{displayFinding(shadowFindings.get(ruleId))}</td></tr>;
        })}</tbody></table></TableFrame>
        : <EmptyState>No findings yet. Use Scrub encounter to run the existing rule pack.</EmptyState>}
    </section>
    {claims.length > 1 ? <p className="version-links">Claim versions: {claims.map((claim) => <Link key={claim.id} href={`/claims/${claim.id}`}>v{claim.version} · {claim.status}</Link>)}</p> : null}
    <ClaimJson document={document} />
  </>;
}
