import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeTask, TaskNotFound } from "@pt-rcm/db";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), completeTask: vi.fn(),
}));
const id = "00000000-0000-4000-8000-000000000020";
const organizationId = "00000000-0000-4000-8000-000000000001";
const params = Promise.resolve({ id });
const request = new Request(`http://localhost/api/tasks/${id}/done`, { method: "POST" });

describe("POST /api/tasks/:id/done", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("INGEST_ORGANIZATION_ID", organizationId); });
  it("returns the completed task in server-owned organization scope", async () => {
    const task = { id, claimId: id, kind: "RULE_BLOCK", owner: "OPERATOR" as const, status: "DONE" as const, reason: "POC_INVALID" };
    vi.mocked(completeTask).mockResolvedValue(task);
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(completeTask).toHaveBeenCalledWith({}, organizationId, id);
  });
  it("rejects malformed IDs before persistence", async () => {
    const response = await POST(request, { params: Promise.resolve({ id: "invalid" }) });
    expect(response.status).toBe(400);
    expect(completeTask).not.toHaveBeenCalled();
  });
  it("returns 404 for missing or out-of-scope tasks", async () => {
    vi.mocked(completeTask).mockRejectedValue(new TaskNotFound());
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "TASK_NOT_FOUND" });
  });
  it("does not expose internal failure details", async () => {
    vi.mocked(completeTask).mockRejectedValue(new Error("SYN private details"));
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "TASK_COMPLETION_FAILED" });
  });
});
