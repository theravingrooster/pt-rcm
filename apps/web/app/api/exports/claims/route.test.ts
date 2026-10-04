import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimExportQueryError, createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, readClaimExport } from "@pt-rcm/db";
import { GET } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(),
  createDatabase: vi.fn(() => ({ db: {} })), readClaimExport: vi.fn(),
}));

const request = (search = "") => new Request(`http://localhost/api/exports/claims${search}`);

describe("GET /api/exports/claims", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
  it("returns no-store JSON, a page cursor, and an organization scoped query", async () => {
    vi.mocked(readClaimExport).mockResolvedValue({ rows: [], nextCursor: "opaque-cursor" });
    const response = await GET(request("?status=DENIED&limit=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ rows: [], nextCursor: "opaque-cursor" });
    expect(readClaimExport).toHaveBeenCalledWith({}, DEFAULT_INGEST_ORGANIZATION_ID,
      { status: "DENIED", limit: 1, cursor: undefined });
  });
  it("defaults page size in the read model and passes the cursor through", async () => {
    vi.mocked(readClaimExport).mockResolvedValue({ rows: [], nextCursor: null });
    await GET(request("?cursor=opaque"));
    expect(readClaimExport).toHaveBeenCalledWith({}, DEFAULT_INGEST_ORGANIZATION_ID,
      { status: undefined, limit: undefined, cursor: "opaque" });
  });
  it.each(["?status=", "?status=UNKNOWN", "?limit=0", "?limit=-1", "?limit=201", "?limit=1.5", "?cursor=", "?status=DENIED&status=PAID"])
  ("rejects invalid query %s without accessing data", async (search) => {
    const response = await GET(request(search));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "INVALID_EXPORT_QUERY" });
    expect(readClaimExport).not.toHaveBeenCalled();
  });
  it("rejects a cursor bound to another filter", async () => {
    vi.mocked(readClaimExport).mockRejectedValue(new ClaimExportQueryError());
    const response = await GET(request("?cursor=other-filter"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_EXPORT_QUERY" });
  });
  it("does not expose database errors", async () => {
    vi.mocked(readClaimExport).mockRejectedValue(new Error("internal SYN member details"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "CLAIM_EXPORT_FAILED" });
  });
});
