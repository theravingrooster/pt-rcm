import MetricsPage from "../metrics/page.js";
import { ClaimsExportForm } from "./claims-export-form.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Reports" };

export default async function ReportsPage() {
  return <>
    <MetricsPage />
    <section className="panel">
      <div className="section-heading"><h2>Claim export</h2><span className="muted">One row per claim version</span></div>
      <ClaimsExportForm />
    </section>
  </>;
}
