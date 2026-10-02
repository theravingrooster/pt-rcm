import { beforeEach, describe, expect, it, vi } from "vitest";
import { listTasks } from "@pt-rcm/db";
import { GET } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), listTasks: vi.fn(),
}));
const organizationId = "00000000-0000-4000-8000-000000000001";

describe("GET /api/tasks", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("INGEST_ORGANIZATION_ID", organizationId); });
  it.each([undefined, "OPEN", "DONE"] as const)("lists %s tasks in server-owned organization scope", async (status) => {
    vi.mocked(listTasks).mockResolvedValue([]);
    const response = await GET(new Request(`http://localhost/api/tasks?organizationId=ignored${status ? `&status=${status}` : ""}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(listTasks).toHaveBeenCalledWith({}, organizationId, status ?? "OPEN");
  });
  it.each(["", "open", "ALL", "UNKNOWN"])("rejects invalid status %s before persistence", async (status) => {
    const response = await GET(new Request(`http://localhost/api/tasks?status=${status}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_TASK_STATUS" });
    expect(listTasks).not.toHaveBeenCalled();
  });
  it("does not expose internal failure details", async () => {
    vi.mocked(listTasks).mockRejectedValue(new Error("SYN private details"));
    const response = await GET(new Request("http://localhost/api/tasks"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "TASK_LIST_FAILED" });
  });
});
