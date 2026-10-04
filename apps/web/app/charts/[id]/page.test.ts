import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOperatorData } from "../../_lib/server.js";
import ChartPage from "./page.js";

vi.mock("../../_lib/server.js", () => ({ loadOperatorData: vi.fn() }));

const encounterId = "00000000-0000-4000-8000-000000000071";
const claimId = "00000000-0000-4000-8000-000000000072";

describe("locked chart detail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the recorded UTC intervals and the existing three-unit allocator preview", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: {
      noteId: "SYN-SHOULDER-LOCK", encounter: { id: encounterId, dateOfService: "2026-10-01", status: "DRAFT" },
      patient: { externalId: "SYN-PATIENT-1" }, provider: { npi: "0000000003" },
      latestClaim: { id: claimId, version: 1, status: "SCRUBBED" }, status: "SCRUBBED",
      rawMinutes: 40, billableUnionMinutes: 40, overlappingMinutes: 0,
      entries: [
        { id: "line-1", cptCode: "97110", minutes: 20, rawMinutes: 20, billableMinutes: 20, performer: "PT", timing: { startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" } },
        { id: "line-2", cptCode: "97530", minutes: 20, rawMinutes: 20, billableMinutes: 20, performer: "PT", timing: { startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z" } },
      ],
      allocation: { totalTimedMinutes: 40, totalUnits: 3, unusedMinutes: 0, flags: [], lines: [
        { cptCode: "97110", minutes: 20, units: 2, remainderMinutes: 5 },
        { cptCode: "97530", minutes: 20, units: 1, remainderMinutes: 5 },
      ] },
    } } as never);
    const html = renderToStaticMarkup(await ChartPage({ params: Promise.resolve({ id: encounterId }) }));
    expect(html).toContain("2026-10-01T09:00:00Z");
    expect(html).toContain("2026-10-01T09:20:00Z");
    expect(html).toContain("2026-10-01T09:40:00Z");
    expect(html).toContain("3</strong> units");
    expect(html).toContain(`/claims/${claimId}`);
    expect(html).toContain("SCRUBBED");
    expect(html).toContain("Billable union");
    expect(html).toContain("Performer");
    expect(html).toMatch(/<td>PT<\/td>/);
    expect(html).not.toContain("PTA");
    expect(html).not.toContain("OVERLAPPING_MINUTES");
    expect(html).not.toContain("Encounter: DRAFT");
  });

  it("shows credited minutes and a 30-minute allocator preview for an overlapping note", async () => {
    vi.mocked(loadOperatorData).mockResolvedValue({ ok: true, data: {
      noteId: "SYN-OVERLAP-LOCK", encounter: { id: encounterId, dateOfService: "2026-10-01" },
      patient: { externalId: "SYN-PATIENT-1" }, provider: { npi: "0000000003" },
      latestClaim: { id: claimId, version: 1, status: "SCRUBBED" },
      rawMinutes: 40, billableUnionMinutes: 30, overlappingMinutes: 10,
      entries: [
        { id: "line-1", cptCode: "97110", minutes: 20, rawMinutes: 20, billableMinutes: 20, performer: "PTA",
          timing: { startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" } },
        { id: "line-2", cptCode: "97140", minutes: 10, rawMinutes: 20, billableMinutes: 10, performer: "PT",
          timing: { startTime: "2026-10-01T09:10:00Z", stopTime: "2026-10-01T09:30:00Z" } },
      ],
      allocation: { totalTimedMinutes: 30, totalUnits: 2, unusedMinutes: 0, flags: [], lines: [
        { cptCode: "97110", minutes: 20, units: 1, remainderMinutes: 5 },
        { cptCode: "97140", minutes: 10, units: 1, remainderMinutes: 10 },
      ] },
    } } as never);
    const html = renderToStaticMarkup(await ChartPage({ params: Promise.resolve({ id: encounterId }) }));
    expect(html).toContain("OVERLAPPING_MINUTES");
    expect(html).toContain("40</dd>");
    expect(html).toContain("30</dd>");
    expect(html).toContain("30</strong> billable union minutes");
    expect(html).toMatch(/<td>PTA<\/td>/);
    expect(html).toMatch(/<td class="number">20<\/td><td class="number">10<\/td>/);
  });
});
