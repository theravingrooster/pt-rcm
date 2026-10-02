import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export * from "./encounter-ingest.js";

// Importing the package does not open a connection or contact a clearinghouse.
export function createDatabase(url: string) {
  const client = postgres(url);
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDatabase>["db"];
