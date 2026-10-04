import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export * from "./encounter-ingest.js";
export * from "./chart-lock.js";
export * from "./charts-console-read.js";
export * from "./encounter-scrub.js";
export * from "./claim-document.js";
export * from "./claim-submit.js";
export * from "./modifier-apply.js";
export * from "./denial-correction.js";
export * from "./patient-payment.js";
export { ClaimLifecycleError, transitionStoredClaim } from "./claim-lifecycle.js";
export { TaskNotFound, listTasks, completeTask } from "./tasks.js";
export * from "./remit-post.js";
export * from "./remit-poll.js";
export * from "./coverage-eligibility.js";
export * from "./operator-read.js";
export * from "./metrics-read.js";
export * from "./claims-console-read.js";
export * from "./claims-export.js";
export * from "./config-console-read.js";
export * from "./people-remits-read.js";
export * from "./rules-console-read.js";
export * from "./rule-fire-repository.js";
export * from "./rule-packs.js";

// Importing the package does not open a connection or contact a clearinghouse.
export function createDatabase(url: string) {
  const client = postgres(url);
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDatabase>["db"];
