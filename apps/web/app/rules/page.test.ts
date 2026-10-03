import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOperatorData } from "../_lib/server.js";
import { ruleGroups, ruleOutcomes } from "./rule-catalog.js";
import RulesPage from "./page.js";
import RulePage from "./[id]/page.js";

vi.mock("../_lib/server.js", () => ({ loadOperatorData: vi.fn() }));

const requested = ["gp-modifier", "eight-minute-applied", "zero-minute-timed", "kx-threshold", "auth-visits",
  "plan-of-care", "eval-with-treatment", "distinct-procedure", "coverage-inactive"];
const sample = { id: "coverage-inactive", version: 1, description: "Check the most recent eligibility result.", active: false, shadow: true };

describe("rule console", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers each requested rule once, plus the staged cap rule once", () => {
    const ids = ruleGroups.flatMap((section) => section.steps.flatMap((step) => [...step.ids]));
    expect(ids.filter((id) => requested.includes(id))).toHaveLength(requested.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("timed-code-cap");
    expect(ids.every((id) => ruleOutcomes[id]?.includes("PASS"))).toBe(true);
  });

  it("shows pack status and code-backed outcomes without an editor", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: { activeVersion: "1", shadowVersion: "3", rules: [sample] } } as never);
    const html = renderToStaticMarkup(await RulesPage());
    expect(html).toContain("Claim submission");
    expect(html).toContain("Validate claim");
    expect(html).toContain('href="/rules/coverage-inactive"');
    expect(html).toContain("SHADOW");
    expect(html).toContain("Rules are versioned in code.");
    expect(html).toContain("disabled");
    expect(html).not.toContain("<form");
  });

  it("shows recent RuleFire rows with claim links", async () => {
    const fire = { id: "fire-1", createdAt: "2026-10-02T18:45:00.000Z", shadow: true, outcome: "FLAG", ruleVersion: "1",
      detailJson: { code: "ELIGIBILITY_NOT_RUN", message: "No check exists." } };
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: { rule: sample, activeVersion: "1", shadowVersion: "3",
      fires: [{ fire, pack: { version: "3" }, encounter: { id: "enc-1", dateOfService: "2026-10-02" },
        claim: { id: "claim-1", version: 1 }, patient: { firstName: "Synthetic", lastName: "Patient" } }] } } as never);
    const html = renderToStaticMarkup(await RulePage({ params: Promise.resolve({ id: sample.id }) }));
    expect(html).toContain("Last RuleFire rows");
    expect(html).toContain("ELIGIBILITY_NOT_RUN");
    expect(html).toContain('href="/claims/claim-1"');
    expect(html).toContain('href="/encounters/enc-1"');
  });
});
