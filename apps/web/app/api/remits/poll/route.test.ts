import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureClearinghouse } from "@pt-rcm/clearinghouse";
import { RemitNotPostable } from "@pt-rcm/domain";
import { loadFixtureRemitScripts, pollRemits, RemitPostingError } from "@pt-rcm/db";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), loadFixtureRemitScripts: vi.fn(), pollRemits: vi.fn(),
}));
const organizationId = "00000000-0000-4000-8000-000000000001";
const request = (query = "") => new Request(`http://localhost/api/remits/poll${query}`, { method: "POST" });

describe("POST /api/remits/poll", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("CLEARINGHOUSE_ADAPTER", "fixture"); vi.stubEnv("INGEST_ORGANIZATION_ID", organizationId);
    vi.mocked(loadFixtureRemitScripts).mockResolvedValue([]); vi.mocked(pollRemits).mockResolvedValue({ results: [] });
  });
  it.each(["", "?since=2026-10-01", "?since=2026-10-01T00:00:00.000Z"])("polls the fixture with server-owned organization scope: %s", async (query) => {
    const response = await POST(request(query));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(loadFixtureRemitScripts).toHaveBeenCalledWith({}, organizationId);
    expect(pollRemits).toHaveBeenCalledWith({}, organizationId, query ? query.slice(7) : "1970-01-01", { adapter: "fixture", clearinghouse: expect.any(FixtureClearinghouse) });
  });
  it.each([undefined, "", "stedi", "Fixture"])("refuses adapter %s before database access or fixture calls", async (adapter) => {
    vi.stubEnv("CLEARINGHOUSE_ADAPTER", adapter);
    expect((await POST(request())).status).toBe(503);
    expect(loadFixtureRemitScripts).not.toHaveBeenCalled(); expect(pollRemits).not.toHaveBeenCalled();
  });
  it("rejects invalid since values before persistence", async () => {
    expect((await POST(request("?since=tomorrow"))).status).toBe(400);
    expect(loadFixtureRemitScripts).not.toHaveBeenCalled();
  });
  it.each([new RemitPostingError(409, "REMIT_ID_CONFLICT", "Conflicting receipt"), new RemitPostingError(404, "CLAIM_NOT_FOUND", "Not found")])("maps a posting error %#", async (error) => {
    vi.mocked(pollRemits).mockRejectedValue(error);
    expect((await POST(request())).status).toBe(error.status);
  });
  it("refuses invalid claim states", async () => {
    vi.mocked(pollRemits).mockRejectedValue(new RemitNotPostable("Cannot post"));
    expect((await POST(request())).status).toBe(409);
  });
  it("does not expose unexpected failure details", async () => {
    vi.mocked(pollRemits).mockRejectedValue(new Error("SYN private details"));
    const response = await POST(request());
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "REMIT_POLL_FAILED" });
  });
});
