export type ClaimExportRow = {
  claimId: string;
  version: number;
  patientExternalId: string;
  dateOfService: string;
  payer: string;
  status: string;
  chargeCents: number;
  paidCents: number;
  patientResponsibilityCents: number;
  units: number;
  cptCodes: string[];
};

// Explicit columns prevent unrelated patient or coverage fields from reaching the CSV.
export const CLAIM_EXPORT_COLUMNS = [
  "claimId", "version", "patientExternalId", "dateOfService", "payer", "status",
  "chargeCents", "paidCents", "patientResponsibilityCents", "units", "cptCodes",
] as const satisfies readonly (keyof ClaimExportRow)[];

function csvCell(value: string | number) {
  // Keep operator-entered identifiers from being interpreted as formulas by spreadsheets.
  const text = typeof value === "string" && /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildClaimsCsv(rows: ClaimExportRow[]) {
  return [
    CLAIM_EXPORT_COLUMNS.join(","),
    ...rows.map((row) => CLAIM_EXPORT_COLUMNS.map((key) => csvCell(key === "cptCodes" ? row.cptCodes.join(" | ") : row[key])).join(",")),
  ].join("\r\n") + "\r\n";
}

type ClaimExportPage = { rows: ClaimExportRow[]; nextCursor: string | null };

export async function fetchClaimsExportRows(status: string, request: typeof fetch = fetch) {
  const rows: ClaimExportRow[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const params = new URLSearchParams({ limit: "50" });
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    const response = await request(`/api/exports/claims?${params}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error("Claim export is unavailable.");
    const page: ClaimExportPage = await response.json();
    if (!Array.isArray(page.rows) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
      throw new Error("Claim export returned an invalid page.");
    }
    rows.push(...page.rows);
    cursor = page.nextCursor;
    if (cursor) {
      if (seen.has(cursor)) throw new Error("Claim export returned a repeated cursor.");
      seen.add(cursor);
    }
  } while (cursor);
  return rows;
}
