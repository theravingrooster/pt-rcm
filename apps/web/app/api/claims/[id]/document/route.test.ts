import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildClaimDocument, ClaimNotSubmittable, renderClaimDocumentJson } from "@pt-rcm/domain";
import { ClaimDocumentReadError, getClaimDocument } from "@pt-rcm/db";
import { makeClaimDocumentInput } from "../../../../../../../packages/domain/src/testing/claimDocument.js";
import { GET } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })), getClaimDocument: vi.fn(),
}));
const document = buildClaimDocument(makeClaimDocumentInput());
const request = new Request(`http://localhost/api/claims/${document.claimId}/document`);
const params = Promise.resolve({ id: document.claimId });

describe("GET /api/claims/:id/document", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
  it("returns pretty JSON and prevents cached stale status/document responses", async () => {
    vi.mocked(getClaimDocument).mockResolvedValue(document);
    const response = await GET(request, { params });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe(renderClaimDocumentJson(document));
  });
  it("takes the organization only from server configuration", async () => {
    vi.stubEnv("INGEST_ORGANIZATION_ID", document.submitter.id);
    vi.mocked(getClaimDocument).mockResolvedValue(document);
    await GET(request, { params });
    expect(getClaimDocument).toHaveBeenCalledWith({}, document.submitter.id, document.claimId);
  });
  it("rejects a malformed claim ID before persistence", async () => {
    expect((await GET(request, { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
    expect(getClaimDocument).not.toHaveBeenCalled();
  });
  it.each(["BLOCKED", "DRAFT"] as const)("returns 409 for %s", async (status) => {
    vi.mocked(getClaimDocument).mockRejectedValue(new ClaimNotSubmittable(status));
    const response = await GET(request, { params });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "CLAIM_NOT_SUBMITTABLE" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each([404, 422] as const)("maps read error %i", async (status) => {
    vi.mocked(getClaimDocument).mockRejectedValue(new ClaimDocumentReadError(status, "SYN-ERROR", "Synthetic failure"));
    const response = await GET(request, { params });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "SYN-ERROR", message: "Synthetic failure" });
  });
  it("does not expose internal failure details", async () => {
    vi.mocked(getClaimDocument).mockRejectedValue(new Error("SYN private data"));
    const response = await GET(request, { params });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "CLAIM_DOCUMENT_FAILED" });
  });
});
