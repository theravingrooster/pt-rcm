import { describe, expect, it, vi } from "vitest";
import { buildClaimsCsv, CLAIM_EXPORT_COLUMNS, fetchClaimsExportRows, type ClaimExportRow } from "./claims-export.js";

const row: ClaimExportRow = {
  claimId: "00000000-0000-4000-8000-000000000101", version: 2,
  patientExternalId: 'SYN,"SHOULDER', dateOfService: "2026-10-02", payer: "SYN Medicare",
  status: "PATIENT_BALANCE", chargeCents: 13500, paidCents: 10800,
  patientResponsibilityCents: 2700, units: 3, cptCodes: ["97110", "97530"],
};

describe("Reports claim export", () => {
  it("writes exactly the approved columns, escapes CSV, and never exports member IDs or names", () => {
    const extra = { ...row, memberId: "SYN-SECRET-MEMBER", patientName: "Synthetic Secret" };
    const csv = buildClaimsCsv([extra]);
    expect(CLAIM_EXPORT_COLUMNS).toEqual([
      "claimId", "version", "patientExternalId", "dateOfService", "payer", "status",
      "chargeCents", "paidCents", "patientResponsibilityCents", "units", "cptCodes",
    ]);
    expect(csv).toBe(
      "claimId,version,patientExternalId,dateOfService,payer,status,chargeCents,paidCents,patientResponsibilityCents,units,cptCodes\r\n" +
      '00000000-0000-4000-8000-000000000101,2,"SYN,""SHOULDER",2026-10-02,SYN Medicare,PATIENT_BALANCE,13500,10800,2700,3,97110 | 97530\r\n',
    );
    expect(csv).not.toContain("SYN-SECRET-MEMBER");
    expect(csv).not.toContain("Synthetic Secret");
  });

  it("renders operator-entered identifiers as text rather than spreadsheet formulas", () => {
    expect(buildClaimsCsv([{ ...row, patientExternalId: '=HYPERLINK("https://example.test", "open")' }]))
      .toContain('"\'=HYPERLINK(""https://example.test"", ""open"")"');
  });

  it("downloads all pages under the selected status without repeating a row", async () => {
    const other = { ...row, claimId: "00000000-0000-4000-8000-000000000102", version: 1 };
    const request = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return new Response(JSON.stringify(params.has("cursor")
        ? { rows: [other], nextCursor: null }
        : { rows: [row], nextCursor: "next/claim+version=" }), { status: 200 });
    });
    expect(await fetchClaimsExportRows("PATIENT_BALANCE", request as unknown as typeof fetch)).toEqual([row, other]);
    expect(request).toHaveBeenCalledTimes(2);
    const urls = request.mock.calls.map(([url]) => new URL(url, "http://localhost"));
    expect(urls.every((url) => url.pathname === "/api/exports/claims" &&
      url.searchParams.get("status") === "PATIENT_BALANCE" && url.searchParams.get("limit") === "50")).toBe(true);
    expect(urls[0]!.searchParams.has("cursor")).toBe(false);
    expect(urls[1]!.searchParams.get("cursor")).toBe("next/claim+version=");
  });

  it("refuses a repeating cursor instead of fetching indefinitely", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ rows: [row], nextCursor: "repeat" }), { status: 200 }));
    await expect(fetchClaimsExportRows("", request as unknown as typeof fetch)).rejects.toThrow("repeated cursor");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
