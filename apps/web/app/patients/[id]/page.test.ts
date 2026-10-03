import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOperatorData } from "../../_lib/server.js";
import PatientPage from "./page.js";

vi.mock("../../_lib/server.js", () => ({ loadOperatorData: vi.fn(), fixtureDisabledReason: () => undefined }));
vi.mock("../../_components/action-form.js", () => ({
  ActionForm: ({ label, endpoint }: { label: string; endpoint: string }) => createElement("button", { "data-endpoint": endpoint }, label),
}));

const id = "00000000-0000-4000-8000-000000000007";
const coverageId = "00000000-0000-4000-8000-000000000008";
const coverage = { id: coverageId, memberId: "SYN123", groupNumber: "SYN-GROUP", planName: "SYN Plan",
  active: true, eligible: true, planActive: true, checkedAt: "2026-10-02T12:00:00.000Z", deductibleRemainingCents: 2600 };
const patient = { id, externalId: "SYN-PATIENT", firstName: "SYN", lastName: "Shoulder", dob: "1990-01-01", sex: "F" };

describe("patient coverage detail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the saved eligibility check and fixture-only action", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: { patient, coverages: [{ coverage, payer: { name: "Medicare" } }], encounters: [] } } as never);
    const html = renderToStaticMarkup(await PatientPage({ params: Promise.resolve({ id }) }));
    expect(html).toContain("2026-10-02T12:00:00.000Z");
    expect(html).toContain("Eligible");
    expect(html).toContain("$26.00");
    expect(html).toContain(`/api/coverage/${coverageId}/eligibility`);
    expect(html).toContain("Check eligibility (fixture)");
  });

  it("labels a missing check without inventing an eligibility result", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: { patient,
      coverages: [{ coverage: { ...coverage, checkedAt: null, eligible: null, planActive: null, deductibleRemainingCents: null }, payer: { name: "Medicare" } }], encounters: [] } } as never);
    const html = renderToStaticMarkup(await PatientPage({ params: Promise.resolve({ id }) }));
    expect(html).toContain("Not checked");
    expect(html).toContain("No result");
    expect(html).toContain("Plan not checked");
  });
});
