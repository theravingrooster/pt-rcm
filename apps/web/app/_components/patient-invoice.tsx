import type { PatientInvoice as Invoice } from "@pt-rcm/db";
import { money, TableFrame } from "./operator.js";

export function PatientInvoice({ invoice }: { invoice: Invoice }) {
  return <>
    <TableFrame label="Patient invoice lines"><table><thead><tr><th scope="col">Line</th><th scope="col" className="number">Units</th><th scope="col" className="number">Charge</th><th scope="col" className="number">Payer paid</th><th scope="col" className="number">Patient owed</th></tr></thead>
      <tbody>{invoice.lines.map((line) => <tr key={line.claimLineId}><td className="mono">{line.cptCode}{line.modifiers.length ? ` · ${line.modifiers.join(", ")}` : ""}</td><td className="number">{line.units}</td><td className="number">{money(line.chargeCents)}</td><td className="number">{money(line.payerPaidCents)}</td><td className="number">{money(line.patientOwedCents)}</td></tr>)}</tbody>
      <tfoot><tr><th scope="row" colSpan={2}>Total</th><td className="number">{money(invoice.chargeCents)}</td><td className="number">{money(invoice.payerPaidCents)}</td><td className="number">{money(invoice.patientOwedCents)}</td></tr></tfoot>
    </table></TableFrame>
    <dl className="invoice-summary"><div><dt>Patient responsibility</dt><dd>{money(invoice.patientOwedCents)}</dd></div><div><dt>Patient payments</dt><dd>{money(invoice.paidByPatientCents)}</dd></div><div><dt>Remaining balance</dt><dd><strong>{money(invoice.remainingCents)}</strong></dd></div></dl>
    {invoice.payments.length ? <p className="invoice-payments">Synthetic payments: {invoice.payments.map((payment) => `${payment.recordedAt.slice(0, 10)} ${money(payment.amountCents)}`).join(" · ")}</p> : null}
  </>;
}
