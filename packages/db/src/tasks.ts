import { and, eq, getTableColumns } from "drizzle-orm";
import { IdSchema, TaskStatusSchema, type TaskStatus } from "@pt-rcm/domain";
import type { Database } from "./index.js";
import * as s from "./schema.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ClaimTaskKind = "RULE_BLOCK" | "DENIAL_REVIEW" | "PATIENT_INVOICE";

export class TaskNotFound extends Error {
  readonly code = "TASK_NOT_FOUND";
  readonly status = 404;
  constructor() { super("Task not found in this organization"); this.name = "TaskNotFound"; }
}

/** The claim lock serializes open/close, so repeated or concurrent findings
 * create at most one open task of each kind. Call inside the claim transaction.
 * All three are operator work: PATIENT_INVOICE requests invoice preparation.
 */
export async function openClaimTask(tx: Transaction, claimId: string, kind: ClaimTaskKind, reason: string) {
  await tx.select({ id: s.claims.id }).from(s.claims).where(eq(s.claims.id, claimId)).for("update");
  const [existing] = await tx.select().from(s.tasks).where(and(
    eq(s.tasks.claimId, claimId), eq(s.tasks.kind, kind), eq(s.tasks.status, "OPEN"),
  ));
  if (existing) return existing;
  const [task] = await tx.insert(s.tasks).values({ claimId, kind, owner: "OPERATOR", status: "OPEN", reason }).returning();
  return task!;
}

export async function listTasks(db: Database, organizationId: string, status: TaskStatus = "OPEN") {
  IdSchema.parse(organizationId);
  TaskStatusSchema.parse(status);
  return db.select(getTableColumns(s.tasks)).from(s.tasks)
    .innerJoin(s.claims, eq(s.claims.id, s.tasks.claimId))
    .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
    .where(and(eq(s.encounters.organizationId, organizationId), eq(s.tasks.status, status)))
    .orderBy(s.tasks.id);
}

export async function completeTask(db: Database, organizationId: string, taskId: string) {
  IdSchema.parse(organizationId);
  IdSchema.parse(taskId);
  return db.transaction(async (tx) => {
    const [reference] = await tx.select({ claimId: s.tasks.claimId }).from(s.tasks)
      .innerJoin(s.claims, eq(s.claims.id, s.tasks.claimId))
      .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
      .where(and(eq(s.tasks.id, taskId), eq(s.encounters.organizationId, organizationId)));
    if (!reference) throw new TaskNotFound();
    // Claim before task, matching openClaimTask. No encounter lock is acquired later.
    await tx.select({ id: s.claims.id }).from(s.claims).where(eq(s.claims.id, reference.claimId)).for("update");
    const [task] = await tx.select().from(s.tasks).where(eq(s.tasks.id, taskId)).for("update");
    if (!task) throw new TaskNotFound();
    if (task.status === "DONE") return task;
    const [done] = await tx.update(s.tasks).set({ status: "DONE" }).where(eq(s.tasks.id, taskId)).returning();
    await tx.insert(s.auditEvents).values({
      actor: "SYN-OPERATOR", action: "TASK_COMPLETED", entity: "Task", entityId: taskId,
      at: new Date().toISOString(), detailJson: { claimId: task.claimId, kind: task.kind, from: "OPEN", to: "DONE" },
    });
    return done!;
  });
}
