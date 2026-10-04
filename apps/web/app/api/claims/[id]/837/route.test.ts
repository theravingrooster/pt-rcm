import { beforeEach, describe, expect, it, vi } from "vitest";
import { map837p, Synthetic837DocumentError } from "@pt-rcm/clearinghouse";
import { buildClaimDocument, ClaimNotSubmittable } from "@pt-rcm/domain";
import { ClaimDocumentReadError, getClaimDocumentFor837 } from "@pt-rcm/db";
import { makeClaimDocumentInput } from "../../../../../../../packages/domain/src/testing/claimDocument.js";
import { GET } from "./route.js";

vi.mock("@pt-rcm/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/db")>(), createDatabase: vi.fn(() => ({ db: {} })),
  getClaimDocumentFor837: vi.fn(),
}));
vi.mock("@pt-rcm/clearinghouse", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pt-rcm/clearinghouse")>(), map837p: vi.fn(() => "SYNTHETIC 837P FIXTURE\n"),
}));

const document = buildClaimDocument(makeClaimDocumentInput());
const request = new Request(`http://localhost/api/claims/${document.claimId}/837`);
const params = Promise.resolve({ id: document.claimId });

describe("GET /api/claims/:id/837", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

  it("downloads the synthetic text for the saved claim without submitting it", async () => {
    vi.stubEnv("INGEST_ORGANIZATION_ID", document.submitter.id);
    vi.mocked(getClaimDocumentFor837).mockResolvedValue(document);
    const response = await GET(request, { params });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("SYNTHETIC 837P FIXTURE\n");
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Disposition"))
      .toBe(`attachment; filename="SYN-claim-${document.claimId}-v${document.claimVersion}.837.txt"`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(getClaimDocumentFor837).toHaveBeenCalledWith({}, document.submitter.id, document.claimId);
    expect(map837p).toHaveBeenCalledWith(document);
  });

  it.each(["BLOCKED", "DRAFT", "SHADOWED"] as const)("refuses a %s claim before generating text", async (status) => {
    vi.mocked(getClaimDocumentFor837).mockRejectedValue(new ClaimNotSubmittable(status));
    const response = await GET(request, { params });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "CLAIM_NOT_SUBMITTABLE" });
    expect(map837p).not.toHaveBeenCalled();
  });

  it("rejects a malformed claim id before a database read", async () => {
    expect((await GET(request, { params: Promise.resolve({ id: "invalid" }) })).status).toBe(400);
    expect(getClaimDocumentFor837).not.toHaveBeenCalled();
  });

  it.each([404, 422] as const)("maps saved document read errors %i", async (status) => {
    const error = new ClaimDocumentReadError(status, "SYN-ERROR", "Document unavailable");
    vi.mocked(getClaimDocumentFor837).mockRejectedValue(error);
    const response = await GET(request, { params });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: error.code, message: error.message });
  });

  it("reports a synthetic writer validation error without returning a partial file", async () => {
    vi.mocked(getClaimDocumentFor837).mockResolvedValue(document);
    vi.mocked(map837p).mockImplementationOnce(() => { throw new Synthetic837DocumentError("Subscriber demographics unavailable"); });
    const response = await GET(request, { params });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INVALID_837_FIXTURE_DOCUMENT", message: "Subscriber demographics unavailable" });
    expect(response.headers.get("Content-Disposition")).toBeNull();
  });

  it("keeps unexpected failure details out of the response", async () => {
    vi.mocked(getClaimDocumentFor837).mockRejectedValue(new Error("SYN private member data"));
    const response = await GET(request, { params });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "SYNTHETIC_837_FAILED" });
  });
});
