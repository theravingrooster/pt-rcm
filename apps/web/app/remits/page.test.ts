import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOperatorData } from "../_lib/server.js";
import RemitsPage from "./page.js";

vi.mock("../_lib/server.js", () => ({ loadOperatorData: vi.fn(), fixtureDisabledReason: () => undefined }));
vi.mock("../_components/action-form.js", () => ({
  ActionForm: ({ label }: { label: string }) => createElement("button", null, label),
}));

describe("posted remits ledger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("links a receipt to claim detail with amounts and match status", async () => {
    const id = "00000000-0000-4000-8000-000000000010";
    const claimId = "00000000-0000-4000-8000-000000000011";
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: [{
      remit: { id, payerIcn: "SYN-ICN-1", receivedOn: "2026-10-02", paidCents: 8000, adjustmentCents: 1000,
        patientResponsibilityCents: 2000, detailJson: { result: { remitId: id, claimId, status: "PATIENT_BALANCE", matched: true,
          duplicate: false, flags: [], authorizationVisitDecremented: false } } },
      claim: { id: claimId, version: 1, status: "PATIENT_BALANCE" },
      encounter: { dateOfService: "2026-10-01" }, patient: { id, firstName: "SYN", lastName: "Patient" }, payer: { name: "Medicare" },
    }] } as never);
    const html = renderToStaticMarkup(await RemitsPage());
    expect(html).toContain("SYN-ICN-1");
    expect(html).toContain(`/claims/${claimId}`);
    expect(html).toContain("Matched");
    expect(html).toContain("$80.00");
    expect(html).toContain("$20.00");
  });

  it("shows the seed command when there are no receipts", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: [] } as never);
    const html = renderToStaticMarkup(await RemitsPage());
    expect(html).toContain("pnpm seed:demo");
  });
});
