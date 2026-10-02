import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncounterIngestError, upsertEncounter } from "@pt-rcm/db";
import { POST } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(),
  createDatabase: vi.fn(() => ({ db: {} })),
  upsertEncounter: vi.fn(),
}));

const body = JSON.parse(readFileSync(new URL("../../../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8"));
const request = (value: unknown = body) => new Request("http://localhost/api/encounters", {
  method: "POST", body: JSON.stringify(value), headers: { "content-type": "application/json" },
});
const result = { encounterId: "00000000-0000-4000-8000-000000000101", patientId: "00000000-0000-4000-8000-000000000102", status: "DRAFT" as const, created: true };

describe("POST /api/encounters", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
  it.each([[true, 201], [false, 200]] as const)("created=%s responds %s", async (created, status) => {
    vi.mocked(upsertEncounter).mockResolvedValue({ ...result, created });
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ...result, created });
  });
  it("uses only the server organization", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000999";
    vi.stubEnv("INGEST_ORGANIZATION_ID", organizationId);
    vi.mocked(upsertEncounter).mockResolvedValue(result);
    await POST(request());
    expect(upsertEncounter).toHaveBeenCalledWith({}, organizationId, expect.any(Object));
  });
  it("rejects invalid JSON without accessing persistence", async () => {
    const response = await POST(new Request("http://localhost/api/encounters", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(upsertEncounter).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, minuteLines: [{ cptCode: "99999", minutes: 23 }] },
    { ...body, minuteLines: [{ cptCode: "97110", minutes: 481 }] },
    { ...body, organizationId: result.patientId },
  ])("rejects an invalid body before persistence %#", async (input) => {
    expect((await POST(request(input))).status).toBe(400);
    expect(upsertEncounter).not.toHaveBeenCalled();
  });
  it.each([409, 422] as const)("maps a persistence error to %s", async (status) => {
    vi.mocked(upsertEncounter).mockRejectedValue(new EncounterIngestError(status, "SYN-ERROR", "Synthetic failure"));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "SYN-ERROR", message: "Synthetic failure" });
  });
  it("does not expose database error details", async () => {
    vi.mocked(upsertEncounter).mockRejectedValue(new Error("SYN private database detail"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "INGEST_FAILED" });
  });
});
