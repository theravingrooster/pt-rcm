import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChartLockError, EncounterIngestError, EncounterScrubError, lockPtChartNote } from "@pt-rcm/db";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(),
  createDatabase: vi.fn(() => ({ db: {} })),
  lockPtChartNote: vi.fn(),
}));

const note = {
  externalNoteId: "SYN-LOCKED-SHOULDER-NOTE",
  patientExternalId: "SYN-PATIENT-SHOULDER",
  renderingNpi: "0000000003",
  dateOfService: "2026-10-01",
  diagnoses: ["M25.511"],
  timedEntries: [
    { cptCode: "97110", startTime: "2026-10-01T09:00:00Z", stopTime: "2026-10-01T09:20:00Z" },
    { cptCode: "97530", startTime: "2026-10-01T09:20:00Z", stopTime: "2026-10-01T09:40:00Z" },
  ],
};
const encounterId = "00000000-0000-4000-8000-000000000101";
const claimId = "00000000-0000-4000-8000-000000000102";
const request = (body: unknown = note) => new Request("http://localhost/api/charts/lock", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
});

describe("POST /api/charts/lock", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

  it.each([[true, 201], [false, 200]] as const)("returns only encounter ID when created=%s", async (created, status) => {
    vi.mocked(lockPtChartNote).mockResolvedValue({ encounterId, patientId: encounterId, created, status: "SCRUBBED", claimId, totalUnits: 3 });
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ encounterId });
    expect(lockPtChartNote).toHaveBeenCalledWith({}, expect.any(String), note);
  });

  it("uses a server-scoped organization rather than input", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000999";
    vi.stubEnv("INGEST_ORGANIZATION_ID", organizationId);
    vi.mocked(lockPtChartNote).mockResolvedValue({ encounterId, patientId: encounterId, created: true, status: "SCRUBBED", claimId, totalUnits: 3 });
    await POST(request());
    expect(lockPtChartNote).toHaveBeenCalledWith({}, organizationId, note);
  });

  it.each([
    { ...note, timedEntries: [{ ...note.timedEntries[0], stopTime: "2026-10-01T08:59:00Z" }] },
    { ...note, timedEntries: [{ ...note.timedEntries[0], stopTime: "2026-10-01T17:01:00Z" }] },
    { ...note, timedEntries: [{ ...note.timedEntries[0], cptCode: "99999" }] },
    { ...note, timedEntries: [{ ...note.timedEntries[0], minutes: 20 }] },
    { ...note, patient: { name: "Not a fixture patient" } },
    { ...note, memberId: "123456789" },
    { ...note, renderingNpi: "1234567890" },
  ])("rejects invalid or non-synthetic note input before persistence %#", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(lockPtChartNote).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const response = await POST(new Request("http://localhost/api/charts/lock", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(lockPtChartNote).not.toHaveBeenCalled();
  });

  it("returns 409 when the encounter's claim was submitted", async () => {
    vi.mocked(lockPtChartNote).mockRejectedValue(new EncounterIngestError(409, "CLAIM_ALREADY_SUBMITTED", "Submitted"));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "CLAIM_ALREADY_SUBMITTED", message: "Submitted" });
  });

  it("reports a scrub conflict without claiming the lock succeeded", async () => {
    vi.mocked(lockPtChartNote).mockRejectedValue(new EncounterScrubError(409, "DRAFT_LINES_INVALID", "Stored draft cannot be scrubbed"));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "DRAFT_LINES_INVALID", message: "Stored draft cannot be scrubbed" });
  });

  it("reports missing fixture patient without leaking database details", async () => {
    vi.mocked(lockPtChartNote).mockRejectedValue(new ChartLockError(422, "PATIENT_NOT_FOUND", "Synthetic patient must exist"));
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "PATIENT_NOT_FOUND", message: "Synthetic patient must exist" });
    vi.mocked(lockPtChartNote).mockRejectedValue(new Error("Private database detail"));
    const unexpected = await POST(request());
    expect(unexpected.status).toBe(500);
    expect(await unexpected.json()).toEqual({ error: "CHART_LOCK_FAILED" });
  });
});
