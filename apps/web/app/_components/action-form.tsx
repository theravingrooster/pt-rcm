"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Action = "scrub" | "shadow" | "submit" | "poll" | "done" | "modifier" | "eligibility";
type Props = { action: Action; endpoint: string; label: string; disabledReason?: string; primary?: boolean };

export function ActionForm({ action, endpoint, label, disabledReason, primary = false }: Props) {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || disabledReason) return;
    busy.current = true; setPending(true); setFeedback(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok) {
        const message = typeof data.message === "string" ? data.message : "The action could not be completed.";
        setFeedback({ text: `${typeof data.error === "string" ? `${data.error}: ` : ""}${message}`, error: true });
        return;
      }
      let text = "Task marked done.";
      if (action === "scrub") text = `${data.status}: ${data.totalUnits} units, ${data.blocks.length} blocks.`;
      if (action === "shadow") {
        const findings = Array.isArray(data.findings) ? data.findings : [];
        const simulatedBlocks = findings.filter((finding: { outcome?: string }) => finding?.outcome === "BLOCK").length;
        const pack = data.rulePack && typeof data.rulePack.id === "string" ? `${data.rulePack.id} v${data.rulePack.version}` : "candidate pack";
        text = `Shadow ${pack}: ${simulatedBlocks} simulated blocks. Claim remains ${data.status}.`;
      }
      if (action === "submit") text = `Submitted via fixture. ICN: ${data.icn}.`;
      if (action === "modifier") text = `Modifier 59 applied; claim ${data.status ?? "re-scrubbed"}.`;
      if (action === "eligibility") text = `Fixture eligibility checked: ${data.eligible ? "eligible" : "ineligible"}; plan ${data.planActive ? "active" : "inactive"}.`;
      if (action === "poll") {
        const results = data.results as { duplicate: boolean; matched: boolean; flags: unknown[] }[];
        text = `${results.filter((row) => !row.duplicate).length} new remits; ${results.filter((row) => row.duplicate).length} already posted; ${results.filter((row) => !row.matched).length} unmatched; ${results.reduce((sum, row) => sum + row.flags.length, 0)} flags.`;
      }
      setFeedback({ text, error: false });
      startTransition(() => router.refresh());
    } catch {
      setFeedback({ text: "Could not complete the request. Check the connection and try again.", error: true });
    } finally { busy.current = false; setPending(false); }
  }

  return <form onSubmit={submit} className="action-form" aria-label={label} aria-busy={pending || refreshing}>
    <button type="submit" className={primary ? "primary" : undefined} disabled={pending || refreshing || Boolean(disabledReason)}>
      {pending || refreshing ? "Working…" : label}
    </button>
    {disabledReason ? <p className="action-hint">{disabledReason}</p> : null}
    {feedback ? <p className={feedback.error ? "action-feedback failure" : "action-feedback"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
  </form>;
}
