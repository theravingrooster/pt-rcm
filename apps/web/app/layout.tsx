import Link from "next/link";
import "./globals.css";

export const metadata = { title: { default: "Encounters · PT RCM", template: "%s · PT RCM" }, description: "Synthetic outpatient PT billing operator workspace." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className="safety-banner">Synthetic data only. Fixture clearinghouse. Not for live claims.</div>
        <header className="app-header"><Link href="/" className="brand">PT RCM <span>Operator workspace</span></Link>
          <nav aria-label="Main navigation"><Link href="/">Encounters</Link><Link href="/tasks">Open tasks</Link><Link href="/metrics">Metrics</Link></nav>
          <span className="fixture-tag">Fixture environment</span>
        </header>
        <main id="main-content">{children}</main>
      </body>
    </html>
  );
}
