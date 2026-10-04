import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockedPtNote } from "@pt-rcm/domain";
import { loadOperatorData } from "../_lib/server.js";
import ChartsPage from "./page.js";

vi.mock("../_lib/server.js", () => ({ loadOperatorData: vi.fn() }));

const encounterId = "00000000-0000-4000-8000-000000000071";
const overlappingFixture = JSON.parse(readFileSync(new URL("../../../../fixtures/charts/overlapping-30min.json", import.meta.url), "utf8")) as LockedPtNote;
const row = {
  noteId: "SYN-SHOULDER-LOCK", patient: { externalId: "SYN-PATIENT-1" },
  encounter: { id: encounterId, dateOfService: "2026-10-01", status: "DRAFT" },
  claim: { status: "SCRUBBED", version: 2 }, status: "SCRUBBED", units: 3,
  rawMinutes: 40, billableUnionMinutes: 40, overlappingMinutes: 0,
  entries: [
    { id: "line-1", cptCode: "97110", minutes: 20, rawMinutes: 20, billableMinutes: 20, performer: "PT", timing: { startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" } },
    { id: "line-2", cptCode: "97530", minutes: 20, rawMinutes: 20, billableMinutes: 20, performer: "PT", timing: { startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z" } },
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
    expect(html).toContain("97110 · 20 min · PT");
    expect(html).not.toContain("PTA");
    expect(html).toContain("SCRUBBED");
    expect(html).toContain("v2");
    expect(html).toContain("Raw minutes");
    expect(html).toContain("Billable union");
    expect(html).not.toContain("OVERLAPPING_MINUTES");
    expect(html).not.toContain("DRAFT");
    expect(html).not.toContain("Encounter:");
    expect(html).toMatch(/<td class="number">40<\/td>/);
    expect(html).toMatch(/<td class="number">3<\/td>/);
  });

  it("shows the overlap finding only on the overlapping row", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: [row, { ...row,
      noteId: overlappingFixture.externalNoteId,
      encounter: { ...row.encounter, id: "00000000-0000-4000-8000-000000000073" },
      rawMinutes: 40, billableUnionMinutes: 30, overlappingMinutes: 10, units: 2,
      entries: [row.entries[0], { ...row.entries[1], cptCode: overlappingFixture.timedEntries[1]!.cptCode,
        minutes: 10, billableMinutes: 10,
        timing: { startTime: overlappingFixture.timedEntries[1]!.startTime,
          stopTime: overlappingFixture.timedEntries[1]!.stopTime } }],
    }] } as never);
    const html = renderToStaticMarkup(await ChartsPage());
    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
    const sequential = rows.find((item) => item.includes("SYN-SHOULDER-LOCK"));
    const overlapping = rows.find((item) => item.includes(overlappingFixture.externalNoteId));
    expect(sequential).toContain("97530 · 20 min");
    expect(sequential).toMatch(/<td class="number">40<\/td><td class="number">40<\/td>/);
    expect(sequential).not.toContain("OVERLAPPING_MINUTES");
    expect(overlapping).toContain("97140 · 20 min");
    expect(overlapping).toMatch(/<td class="number">40<\/td><td class="number">30<\/td>/);
    expect(overlapping).toContain("OVERLAPPING_MINUTES");
  });

  it("identifies PTA performance in the timed entry on the chart list", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: [{ ...row,
      noteId: "SYN-PTA-20MIN-NOTE",
      entries: [{ ...row.entries[0], performer: "PTA" }],
      rawMinutes: 20, billableUnionMinutes: 20, overlappingMinutes: 0,
    }] } as never);
    const html = renderToStaticMarkup(await ChartsPage());
    expect(html).toContain("97110 · 20 min · PTA");
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
