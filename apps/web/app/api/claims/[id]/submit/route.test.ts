import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import { ClaimNotSubmittable } from "@pt-rcm/domain";
import { ClaimDocumentReadError, ClaimSubmissionError, submitScrubbedClaim } from "@pt-rcm/db";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), submitScrubbedClaim: vi.fn(),
}));
const id = "00000000-0000-4000-8000-000000000020";
const request = new Request(`http://localhost/api/claims/${id}/submit`, { method: "POST" });
const params = Promise.resolve({ id });
const acknowledgment = { icn: `SYN-ICN-${id}`, status: "accepted-for-processing" as const };
const result = { claimId: id, encounterId: id, status: "SUBMITTED" as const, icn: acknowledgment.icn, acknowledgment };

describe("POST /api/claims/:id/submit", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("CLEARINGHOUSE_ADAPTER", "fixture"); });
  it("uses a fixture and returns the submitted receipt", async () => {
    vi.stubEnv("INGEST_ORGANIZATION_ID", id);
    vi.mocked(submitScrubbedClaim).mockResolvedValue(result);
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(submitScrubbedClaim).toHaveBeenCalledWith({}, id, id, { adapter: "fixture", clearinghouse: expect.any(FixtureClearinghouse) });
  });
  it.each([undefined, "", "stedi", "Fixture", "fixture "])("refuses adapter %s before persistence, regardless of API key", async (adapter) => {
    vi.stubEnv("CLEARINGHOUSE_ADAPTER", adapter);
    vi.stubEnv("STEDI_API_KEY", "SYN-NOT-A-KEY");
    const response = await POST(request, { params });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "CLEARINGHOUSE_ADAPTER_DISABLED" });
    expect(submitScrubbedClaim).not.toHaveBeenCalled();
  });
  it.each(["BLOCKED", "DRAFT", "SUBMITTED"] as const)("refuses a %s claim", async (status) => {
    vi.mocked(submitScrubbedClaim).mockRejectedValue(new ClaimNotSubmittable(status));
    const response = await POST(request, { params });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "CLAIM_NOT_SUBMITTABLE" });
  });
  it("rejects invalid IDs before persistence", async () => {
    expect((await POST(request, { params: Promise.resolve({ id: "invalid" }) })).status).toBe(400);
    expect(submitScrubbedClaim).not.toHaveBeenCalled();
  });
  it.each([new ClaimDocumentReadError(404, "CLAIM_NOT_FOUND", "Not found"), new ClaimSubmissionError(409, "CLAIM_NEEDS_SCRUB", "Scrub needed"), new ClaimSubmissionError(502, "INVALID_SUBMIT_ACK", "Invalid ack")])("maps a typed service error %#", async (error) => {
    vi.mocked(submitScrubbedClaim).mockRejectedValue(error);
    const response = await POST(request, { params });
    expect(response.status).toBe(error.status);
    expect(await response.json()).toEqual({ error: error.code, message: error.message });
  });
  it("does not expose unexpected failure details", async () => {
    vi.mocked(submitScrubbedClaim).mockRejectedValue(new Error("SYN private detail"));
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "CLAIM_SUBMISSION_FAILED" });
  });
});
