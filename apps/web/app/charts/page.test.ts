import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOperatorData } from "../_lib/server.js";
import ChartsPage from "./page.js";

vi.mock("../_lib/server.js", () => ({ loadOperatorData: vi.fn() }));

const encounterId = "00000000-0000-4000-8000-000000000071";
const row = {
  noteId: "SYN-SHOULDER-LOCK", patient: { externalId: "SYN-PATIENT-1" },
  encounter: { id: encounterId, dateOfService: "2026-10-01", status: "DRAFT" },
  claim: { status: "SCRUBBED", version: 2 }, status: "SCRUBBED", units: 3,
  entries: [
    { id: "line-1", cptCode: "97110", minutes: 20, timing: { startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" } },
    { id: "line-2", cptCode: "97530", minutes: 20, timing: { startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z" } },
  ],
};

describe("Charts page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a locked shoulder note with the scrubbed claim and three units", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: [row] } as never);
    const html = renderToStaticMarkup(await ChartsPage());
    expect(html).toContain(`/charts/${encounterId}`);
    expect(html).toContain("SYN-SHOULDER-LOCK");
    expect(html).toContain("SYN-PATIENT-1");
    expect(html).toContain("97110 · 20 min");
    expect(html).toContain("97530 · 20 min");
    expect(html).toContain("SCRUBBED");
    expect(html).toContain("v2");
    expect(html).not.toContain("DRAFT");
    expect(html).not.toContain("Encounter:");
    expect(html).toMatch(/<td class="number">40<\/td>/);
    expect(html).toMatch(/<td class="number">3<\/td>/);
  });

  it("shows DRAFT only when no claim has been created", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: [{ ...row,
      encounter: { ...row.encounter, status: "HELD" }, claim: null, status: "DRAFT",
    }] } as never);
    const html = renderToStaticMarkup(await ChartsPage());
    expect(html).toContain("DRAFT");
    expect(html).not.toContain("HELD");
    expect(html).not.toContain("v2");
  });

  it("points an empty roster to the shoulder seed command", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: [] } as never);
    const html = renderToStaticMarkup(await ChartsPage());
    expect(html).toContain("No locked notes yet.");
    expect(html).toContain("pnpm seed:demo");
  });
});
