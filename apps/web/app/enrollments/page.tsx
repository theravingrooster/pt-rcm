export const metadata = { title: "Enrollments" };

export default function EnrollmentsPage() {
  return <>
    <div className="page-heading"><div><p className="eyebrow">Configuration</p><h1>Enrollments</h1></div></div>
    <section className="panel"><div className="section-heading"><h2>Payer enrollments</h2></div>
      <div className="empty-state"><p>Enrollments are not built in this prototype. There are no enrollment records to review.</p></div>
    </section>
  </>;
}
