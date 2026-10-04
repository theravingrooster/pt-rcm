"use client";

import { useState, type FormEvent } from "react";
import { buildClaimsCsv, fetchClaimsExportRows } from "./claims-export.js";

const statuses = ["DRAFT", "SCRUBBED", "BLOCKED", "SHADOWED", "SUBMITTED", "ACCEPTED", "REJECTED", "PAID", "DENIED", "PATIENT_BALANCE"];

export function ClaimsExportForm() {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      const rows = await fetchClaimsExportRows(status);
      const href = URL.createObjectURL(new Blob([buildClaimsCsv(rows)], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = href;
      link.download = `claims-${status ? status.toLowerCase() : "all"}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 0);
      setMessage(`Downloaded ${rows.length} claim version${rows.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Claim export is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="export-form" onSubmit={download}>
    <label htmlFor="claim-export-status">Status
      <select id="claim-export-status" value={status} onChange={(event) => setStatus(event.target.value)} disabled={busy}>
        <option value="">All statuses</option>
        {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
    <button type="submit" className="primary" disabled={busy}>{busy ? "Preparing CSV…" : "Download claims CSV"}</button>
    {message ? <p className={`action-feedback${failed ? " failure" : ""}`} role="status">{message}</p> : null}
  </form>;
}
