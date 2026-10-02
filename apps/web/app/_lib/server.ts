import { createDatabase, DEFAULT_INGEST_ORGANIZATION_ID, type Database } from "@pt-rcm/db";

// Only Server Components import this module. No connection data reaches forms.
let connection: ReturnType<typeof createDatabase> | undefined;
export async function loadOperatorData<T>(read: (db: Database, organizationId: string) => Promise<T>) {
  try {
    connection ??= createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
    return { ok: true as const, data: await read(connection.db, process.env.INGEST_ORGANIZATION_ID ?? DEFAULT_INGEST_ORGANIZATION_ID) };
  } catch {
    return { ok: false as const };
  }
}

export function fixtureDisabledReason() {
  return process.env.CLEARINGHOUSE_ADAPTER === "fixture" ? undefined : "Set CLEARINGHOUSE_ADAPTER=fixture to enable this action.";
}
