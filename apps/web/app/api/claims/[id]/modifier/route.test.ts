import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySuggestedModifier, ModifierApplicationError } from "@pt-rcm/db";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), applySuggestedModifier: vi.fn(),
}));

const id = "00000000-0000-4000-8000-000000000020";
const organizationId = "00000000-0000-4000-8000-000000000001";
const request = new Request(`http://localhost/api/claims/${id}/modifier`, { method: "POST" });
const params = Promise.resolve({ id });

describe("POST /api/claims/:id/modifier", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("INGEST_ORGANIZATION_ID", organizationId); });

  it("uses server-owned organization scope and returns the re-scrub result", async () => {
    const result = { claimId: id, encounterId: id, status: "SCRUBBED" as const, modifier: "59" as const,
      cptCodes: ["97110", "97530"] as [string, string], lineIndex: 1 };
    vi.mocked(applySuggestedModifier).mockResolvedValue(result as Awaited<ReturnType<typeof applySuggestedModifier>>);
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
    expect(applySuggestedModifier).toHaveBeenCalledWith({}, organizationId, id);
  });

  it("rejects malformed claim IDs before opening the database", async () => {
    const response = await POST(request, { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_CLAIM_ID" });
    expect(applySuggestedModifier).not.toHaveBeenCalled();
  });

  it.each([404, 409, 422] as const)("maps %i operator errors", async (status) => {
    vi.mocked(applySuggestedModifier).mockRejectedValue(new ModifierApplicationError(status, "SYN-ERROR", "Synthetic failure"));
    const response = await POST(request, { params });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "SYN-ERROR", message: "Synthetic failure" });
  });

  it("does not expose internal failure details", async () => {
    vi.mocked(applySuggestedModifier).mockRejectedValue(new Error("SYN private detail"));
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "MODIFIER_APPLICATION_FAILED" });
  });
});
