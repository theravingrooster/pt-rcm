import { beforeEach, describe, expect, it, vi } from "vitest";
import { promoteRulePack, RulePackError } from "@pt-rcm/db";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), promoteRulePack: vi.fn(),
}));

const params = Promise.resolve({ version: "2" });
const url = "http://localhost/api/rule-packs/2/promote";
function request(body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/rule-packs/:version/promote", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each([{}, { confirm: "promote" }, { confirm: true }, []])("requires explicit PROMOTE confirmation: %#", async (body) => {
    expect((await POST(request(body), { params })).status).toBe(400);
    expect(promoteRulePack).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON and versions before touching packs", async () => {
    expect((await POST(new Request(url, { method: "POST", body: "{" }), { params })).status).toBe(400);
    expect((await POST(request({ confirm: "PROMOTE" }), { params: Promise.resolve({ version: "bad" }) })).status).toBe(404);
    expect(promoteRulePack).not.toHaveBeenCalled();
  });
  it("promotes a tested shadow pack", async () => {
    const result = { version: "2", status: "ACTIVE" as const, retiredVersion: "1", testedClaimId: "00000000-0000-4000-8000-000000000021" };
    vi.mocked(promoteRulePack).mockResolvedValue(result);
    const response = await POST(request({ confirm: "PROMOTE" }), { params });
    expect(await response.json()).toEqual(result);
    expect(promoteRulePack).toHaveBeenCalledWith({}, "2");
  });
  it("returns the evidence gate conflict", async () => {
    vi.mocked(promoteRulePack).mockRejectedValue(new RulePackError(409, "SHADOW_EVIDENCE_REQUIRED", "Run shadow first"));
    const response = await POST(request({ confirm: "PROMOTE" }), { params });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "SHADOW_EVIDENCE_REQUIRED" });
  });
});
