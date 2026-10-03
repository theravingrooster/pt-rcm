import { loadCptFixtures, PT_FIXTURE_FEES_CENTS } from "@pt-rcm/domain";
import { money, TableFrame } from "../_components/operator.js";

export const metadata = { title: "Fee schedules" };

export default function FeeSchedulesPage() {
  const rows = loadCptFixtures();
  return <>
    <div className="page-heading"><div><p className="eyebrow">Configuration</p><h1>Fee schedules</h1>
      <p className="muted">Local test fixture amounts only. No payer contract fee schedules are stored in this prototype.</p></div></div>
    <section className="panel"><div className="section-heading"><h2>Local procedure fee fixture</h2><span className="muted">Invented charge per unit; not reimbursement rates</span></div>
      <TableFrame label="Local procedure fee fixture"><table><thead><tr><th scope="col">Code</th><th scope="col">System</th><th scope="col">Description</th><th scope="col">Timing</th><th scope="col" className="number">Charge per unit</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.code}><td className="mono">{row.code}</td><td>{row.codeSystem}</td><td>{row.name}</td><td>{row.timed ? "Timed" : "Untimed"}</td><td className="number">{money(PT_FIXTURE_FEES_CENTS[row.code]!)}</td></tr>)}</tbody>
      </table></TableFrame>
    </section>
  </>;
}
