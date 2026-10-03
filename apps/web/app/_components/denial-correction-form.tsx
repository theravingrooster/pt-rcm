"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Line = { id: string; cptCode: string; units: number; modifiers: string[] };

export function DenialCorrectionForm({ claimId, lines }: { claimId: string; lines: Line[] }) {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const values = new FormData(event.currentTarget);
    const edits = lines.map((line) => ({
      claimLineId: line.id,
      units: Number(values.get(`units:${line.id}`)),
      modifiers: String(values.get(`modifiers:${line.id}`) ?? "").toUpperCase().split(/[\s,]+/).filter(Boolean),
    }));
    busy.current = true; setPending(true); setFeedback(null);
    try {
      const response = await fetch(`/api/claims/${claimId}/correct`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ lines: edits }),
      });
      const result = await response.json();
      if (!response.ok) {
        setFeedback({ text: `${result.error ?? "Correction failed"}: ${result.message ?? "Review the entered lines."}`, error: true });
        return;
      }
      const blocks = Array.isArray(result.blocks) ? result.blocks : [];
      setFeedback({ text: blocks.length
        ? `Re-scrub blocked resubmission: ${blocks.map((block: { code?: string }) => block.code ?? "BLOCK").join(", ")}. Correct the lines and try again.`
        : `Re-scrub passed. Claim v${result.version ?? "next"} is ready for fixture resubmission.`, error: blocks.length > 0 });
      startTransition(() => router.refresh());
    } catch {
      setFeedback({ text: "Could not save the correction. Check the connection and try again.", error: true });
    } finally { busy.current = false; setPending(false); }
  }

  return <form className="correction-form" onSubmit={submit} aria-busy={pending || refreshing}>
    <div className="table-frame" role="region" aria-label="Correct denied claim lines" tabIndex={0}>
      <table><thead><tr><th scope="col">CPT</th><th scope="col">Units to bill</th><th scope="col">Modifiers (comma separated)</th></tr></thead>
        <tbody>{lines.map((line) => <tr key={line.id}>
          <td className="mono">{line.cptCode}</td>
          <td><label className="sr-only" htmlFor={`units-${line.id}`}>Units for {line.cptCode}</label><input id={`units-${line.id}`} name={`units:${line.id}`} type="number" min="1" step="1" required defaultValue={line.units} /></td>
          <td><label className="sr-only" htmlFor={`modifiers-${line.id}`}>Modifiers for {line.cptCode}</label><input id={`modifiers-${line.id}`} name={`modifiers:${line.id}`} type="text" defaultValue={line.modifiers.join(", ")} placeholder="GP, 59" /></td>
        </tr>)}</tbody></table>
    </div>
    <div className="form-footer"><button type="submit" className="primary" disabled={pending || refreshing}>{pending || refreshing ? "Working…" : "Save correction and re-scrub"}</button>
      <span className="muted">Units and modifiers are entered by the operator; the scrub can block resubmission.</span></div>
    {feedback ? <p className={feedback.error ? "action-feedback failure" : "action-feedback"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
  </form>;
}
