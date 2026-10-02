import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncounterScrubError, scrubEncounter } from "@pt-rcm/db";
import { IllegalClaimTransition } from "@pt-rcm/domain";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), scrubEncounter: vi.fn(),
}));
const id = "00000000-0000-4000-8000-000000000101";
const request = new Request(`http://localhost/api/encounters/${id}/scrub`, { method: "POST" });
const params = Promise.resolve({ id });
const result = { encounterId: id, claimId: id, version: 1, status: "SCRUBBED" as const, totalChargeCents: 13500,
  totalUnits: 3, lines: [], findings: [], blocks: [], downgrades: [], submissionAllowed: true };

describe("POST /api/encounters/:id/scrub", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
  it.each(["SCRUBBED", "BLOCKED"] as const)("returns a %s result from the scrub service", async (status) => {
    const expected = { ...result, status, submissionAllowed: status === "SCRUBBED" };
    vi.mocked(scrubEncounter).mockResolvedValue(expected);
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  });
  it("uses server-owned tenant scope", async () => {
    vi.stubEnv("INGEST_ORGANIZATION_ID", id);
    vi.mocked(scrubEncounter).mockResolvedValue(result);
    await POST(request, { params });
    expect(scrubEncounter).toHaveBeenCalledWith({}, id, id);
  });
  it("rejects a malformed ID before persistence", async () => {
    expect((await POST(request, { params: Promise.resolve({ id: "bad-id" }) })).status).toBe(400);
    expect(scrubEncounter).not.toHaveBeenCalled();
  });
  it.each([404, 409, 422] as const)("maps service error %i", async (status) => {
    vi.mocked(scrubEncounter).mockRejectedValue(new EncounterScrubError(status, "SYN-ERROR", "Synthetic failure"));
    const response = await POST(request, { params });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "SYN-ERROR", message: "Synthetic failure" });
  });
  it("keeps internal failure details out of the response", async () => {
    vi.mocked(scrubEncounter).mockRejectedValue(new Error("SYN private details"));
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "SCRUB_FAILED" });
  });
  it("maps an illegal lifecycle transition to a conflict", async () => {
    vi.mocked(scrubEncounter).mockRejectedValue(new IllegalClaimTransition("PAID", "SCRUBBED"));
    const response = await POST(request, { params });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "ILLEGAL_CLAIM_TRANSITION" });
  });
});
