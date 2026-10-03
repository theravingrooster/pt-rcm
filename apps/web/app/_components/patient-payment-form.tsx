"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function PatientPaymentForm({ claimId, remainingCents }: { claimId: string; remainingCents: number }) {
  const router = useRouter();
  const busy = useRef(false);
  const paymentId = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget;
    const entered = String(new FormData(form).get("amount") ?? "").trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(entered)) {
      setFeedback({ text: "Enter a dollar amount with at most two decimal places.", error: true }); return;
    }
    const [dollars, cents = ""] = entered.split(".");
    const amountCents = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
    if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > remainingCents) {
      setFeedback({ text: "Enter a positive amount no greater than the remaining balance.", error: true }); return;
    }
    paymentId.current ??= crypto.randomUUID();
    busy.current = true; setPending(true); setFeedback(null);
    try {
      const response = await fetch(`/api/claims/${claimId}/payment`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ paymentId: paymentId.current, amountCents }),
      });
      const result = await response.json();
      if (!response.ok) {
        setFeedback({ text: `${result.error ?? "Payment failed"}: ${result.message ?? "Review the amount."}`, error: true });
        return;
      }
      paymentId.current = null;
      form.reset();
      setFeedback({ text: `Synthetic payment recorded. Remaining: $${(result.remainingCents / 100).toFixed(2)}. Claim ${result.status}.`, error: false });
      startTransition(() => router.refresh());
    } catch {
      setFeedback({ text: "Could not record the payment. Retry to check the same payment ID.", error: true });
    } finally { busy.current = false; setPending(false); }
  }

  return <form className="payment-form" onSubmit={submit} aria-label="Record synthetic patient payment" aria-busy={pending || refreshing}>
    <label htmlFor="payment-amount">Payment amount (USD)</label>
    <div className="form-footer"><input id="payment-amount" name="amount" type="text" inputMode="decimal" placeholder="0.00" required />
      <button type="submit" className="primary" disabled={pending || refreshing}>{pending || refreshing ? "Working…" : "Record synthetic payment"}</button></div>
    {feedback ? <p className={feedback.error ? "action-feedback failure" : "action-feedback"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
  </form>;
}
