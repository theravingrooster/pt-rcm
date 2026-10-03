import Link from "next/link";
import { NavLink } from "./_components/nav-link.js";
import "./globals.css";

export const metadata = {
  title: { default: "Home · PT RCM", template: "%s · PT RCM" },
  description: "Synthetic outpatient PT revenue-cycle operator workspace.",
};

const operations = [
  ["Home", "/"], ["Reports", "/reports"], ["Claims", "/claims"],
  ["Queues", "/queues"], ["Tasks", "/tasks"], ["Patients", "/patients"], ["Remits", "/remits"],
] as const;
const configuration = [
  ["Rules", "/rules"], ["Providers", "/providers"], ["Payers", "/payers"],
  ["Contracts", "/contracts"], ["Service facilities", "/service-facilities"],
  ["Fee schedules", "/fee-schedules"], ["Enrollments", "/enrollments"], ["Settings", "/settings"],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <div className="safety-banner">Synthetic data only. Fixture clearinghouse. Not for live claims.</div>
    <div className="app-shell">
      <aside className="app-rail" aria-label="Workspace navigation">
        <div className="rail-brand"><Link href="/">PT RCM</Link><span>Operator console</span></div>
        <div className="org-switcher"><span className="rail-label">Organization</span><strong>SYN Ortho PT</strong><span className="org-caption">Synthetic fixture</span></div>
        <nav aria-label="Operations"><h2 className="rail-label">Operations</h2>{operations.map(([label, href]) => <NavLink key={href} href={href}>{label}</NavLink>)}</nav>
        <nav aria-label="Configuration"><h2 className="rail-label">Configuration</h2>{configuration.map(([label, href]) => <NavLink key={href} href={href}>{label}</NavLink>)}</nav>
        <div className="rail-footer">Fixture environment</div>
      </aside>
      <div className="app-workspace"><header className="workspace-header"><span>Revenue cycle / SYN Ortho PT</span><span className="workspace-environment">Fixture</span></header>
        <main id="main-content">{children}</main>
      </div>
    </div>
  </body></html>;
}
