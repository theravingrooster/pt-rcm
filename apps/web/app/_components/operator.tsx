import Link from "next/link";
import type { ReactNode } from "react";

export function Badge({ value }: { value: string }) {
  const tone = ["PASS", "PAID", "ACCEPTED", "SCRUBBED", "DONE"].includes(value) ? "good"
    : ["BLOCK", "BLOCKED", "DENIED", "REJECTED", "HELD"].includes(value) ? "bad"
    : ["FLAG", "PATIENT_BALANCE", "OPEN"].includes(value) ? "warn"
    : ["DOWNGRADE", "SUBMITTED"].includes(value) ? "info" : "neutral";
  return <span className={`badge ${tone}`}>{value}</span>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state"><p>{children}</p><p className="muted">Load the synthetic shoulder demo: <code>pnpm seed:demo</code> <span>(with <code>pnpm dev</code> running).</span></p></div>;
}

export function DataUnavailable() {
  return <section className="empty-state" role="alert"><h1>Operator data is unavailable</h1>
    <p>Check the database connection and run <code>pnpm db:migrate</code> and <code>pnpm db:seed</code>.</p>
    <p>Then run <code>pnpm seed:demo</code> with <code>pnpm dev</code> running.</p><Link href="/">Reload encounters</Link></section>;
}

export function TableFrame({ label, children }: { label: string; children: ReactNode }) {
  return <div className="table-frame" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

export function ClaimJson({ document }: { document: { json: string | null; source: string | null; message: string | null } }) {
  return <section className="panel"><div className="section-heading"><h2>Claim document JSON</h2>{document.source ? <span className="muted">{document.source}</span> : null}</div>
    {document.json ? <details open><summary>Internal claim document</summary><pre className="json" tabIndex={0}>{document.json}</pre></details>
      : <EmptyState>{document.message}</EmptyState>}</section>;
}

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
