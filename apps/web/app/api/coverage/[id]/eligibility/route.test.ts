import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import { checkCoverageEligibility, CoverageEligibilityError } from "@pt-rcm/db";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), checkCoverageEligibility: vi.fn(),
}));
const id = "00000000-0000-4000-8000-000000000020";
const request = new Request(`http://localhost/api/coverage/${id}/eligibility`, { method: "POST" });
const params = Promise.resolve({ id });
const checkedAt = "2026-10-02T00:00:00.000Z";
const result = { coverageId: id, eligible: true, checkedAt, planActive: true, deductibleRemainingCents: null, adapter: "fixture" as const };

describe("POST /api/coverage/:id/eligibility", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("CLEARINGHOUSE_ADAPTER", "fixture"); });
  it("calls the fixture eligibility service for a scoped coverage and returns its cache", async () => {
    vi.stubEnv("INGEST_ORGANIZATION_ID", id);
    vi.mocked(checkCoverageEligibility).mockResolvedValue(result);
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(checkCoverageEligibility).toHaveBeenCalledWith({}, id, id, {
      adapter: "fixture", clearinghouse: expect.any(FixtureClearinghouse),
    });
  });
  it.each([undefined, "", "stedi", "Fixture", "fixture "])("rejects adapter %s before making a lookup", async (adapter) => {
    vi.stubEnv("CLEARINGHOUSE_ADAPTER", adapter);
    vi.stubEnv("STEDI_API_KEY", "SYN-NOT-A-KEY");
    const response = await POST(request, { params });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "CLEARINGHOUSE_ADAPTER_DISABLED" });
    expect(checkCoverageEligibility).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs before making a lookup", async () => {
    expect((await POST(request, { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(400);
    expect(checkCoverageEligibility).not.toHaveBeenCalled();
  });
  it.each([
    new CoverageEligibilityError(404, "COVERAGE_NOT_FOUND", "Coverage not found in this organization"),
    new CoverageEligibilityError(502, "INVALID_ELIGIBILITY_RESULT", "Invalid fixture result"),
  ])("maps the service error %#", async (error) => {
    vi.mocked(checkCoverageEligibility).mockRejectedValue(error);
    const response = await POST(request, { params });
    expect(response.status).toBe(error.status);
    expect(await response.json()).toEqual({ error: error.code, message: error.message });
  });
  it("does not expose unexpected error details", async () => {
    vi.mocked(checkCoverageEligibility).mockRejectedValue(new Error("SYN private detail"));
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "ELIGIBILITY_CHECK_FAILED" });
  });
});
