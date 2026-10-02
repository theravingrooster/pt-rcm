import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOperatorData } from "../../_lib/server.js";
import EncounterPage from "./page.js";

vi.mock("../../_lib/server.js", () => ({ loadOperatorData: vi.fn(), fixtureDisabledReason: () => undefined }));
vi.mock("../../_components/action-form.js", () => ({
  ActionForm: ({ label, endpoint }: { label: string; endpoint: string }) => createElement("button", { "data-endpoint": endpoint }, label),
}));

const id = "00000000-0000-4000-8000-000000000001";
const claimId = "00000000-0000-4000-8000-000000000002";
const suggestion = { ruleId: "distinct-procedure", outcome: "FLAG", shadow: false, ruleVersion: 1,
  createdAt: "2026-10-02T00:00:00.000Z", detailJson: { code: "MISSING_59", message: "Review distinct procedures.",
    suggestedModifier: "59", cptCodes: ["97110", "97530"], suggestedLineIndex: 1 } };

function encounterView(status: string, findings = [suggestion]) {
  return { encounter: { id, externalId: "SYN-SHOULDER", dateOfService: "2026-10-02", status: "DRAFT" },
    patient: { firstName: "Synthetic", lastName: "Patient" }, provider: { firstName: "SYN", lastName: "Provider", npi: "0000000001" },
    facility: { name: "Fixture Clinic", placeOfServiceCode: "11" }, minuteLines: [], diagnoses: [],
    latestClaim: { id: claimId, version: 1, status }, claims: [{ id: claimId, version: 1, status }],
    allocation: { totalTimedMinutes: 0, totalUnits: 0, unusedMinutes: 0, lines: [], flags: [] }, findings,
    rulePacks: { active: "pt-pack v1", shadow: "pt-pack v3", hasShadow: true }, document: { json: null, source: null, message: "Not available" } };
}

async function pageHtml(status: string, findings = [suggestion]) {
  vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: encounterView(status, findings) } as never);
  return renderToStaticMarkup(await EncounterPage({ params: Promise.resolve({ id }) }));
}

describe("encounter suggested modifier control", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["DRAFT", "BLOCKED", "SCRUBBED"])("offers the operator action on a %s claim", async (status) => {
    const html = await pageHtml(status);
    expect(html).toContain("Suggested modifier");
    expect(html).toContain("97110 / 97530");
    expect(html).toContain("apply suggested modifier");
    expect(html).toContain(`/api/claims/${claimId}/modifier`);
  });

  it("does not offer an action after submission or for a shadow-only suggestion", async () => {
    expect(await pageHtml("SUBMITTED")).not.toContain("apply suggested modifier");
    expect(await pageHtml("SCRUBBED", [{ ...suggestion, shadow: true }])).not.toContain("apply suggested modifier");
  });
});
