import { describe, expect, it } from "vitest";
import { RuleFireSchema } from "@pt-rcm/domain";
import { runRules, runRulesWithRepository, toRuleFireRows, type Rule, type RuleFireInsert, type RuleFireRepository } from "./index.js";
import { makeContext, testClaimId } from "./testing/fixtures.js";

class MemoryRepository implements RuleFireRepository {
  rows: RuleFireInsert[] = [];
  calls = 0;
  async insertRuleFires(rows: readonly RuleFireInsert[]) {
    this.calls++;
    this.rows.push(...structuredClone(rows));
  }
}

const rules: Rule[] = [
  { id: "A_PASS", version: 1, description: "Synthetic pass", evaluate: () => ({ outcome: "PASS" }) },
  { id: "B_FLAG", version: 2, description: "Synthetic flag", evaluate: () => ({ outcome: "FLAG", code: "SYN_FLAG", message: "Synthetic flag" }) },
  { id: "C_DOWNGRADE", version: 3, description: "Synthetic downgrade", evaluate: () => ({ outcome: "DOWNGRADE", code: "SYN_REDUCE", message: "Synthetic reduction", linePatches: [{ lineIndex: 0, units: 1 }] }) },
  { id: "D_BLOCK", version: 4, description: "Synthetic block", evaluate: () => ({ outcome: "BLOCK", code: "SYN_BLOCK", message: "Synthetic block" }) },
  { id: "E_CRASH", version: 5, description: "Synthetic crash", evaluate: () => { throw new Error("SYN exception"); } },
];

describe("optional RuleFire persistence", () => {
  it.each(["active", "shadow"] as const)("persists every result, including PASS and RULE_CRASH, in one %s batch", async (mode) => {
    const repository = new MemoryRepository();
    const ctx = makeContext(mode);
    const run = await runRulesWithRepository([...rules].reverse(), ctx, { claimId: testClaimId, repository });
    expect(run).toEqual(runRules(rules, ctx));
    expect(repository.calls).toBe(1);
    expect(repository.rows.map(({ ruleId, ruleVersion, outcome, shadow }) => [ruleId, ruleVersion, outcome, shadow])).toEqual([
      ["A_PASS", "1", "PASS", mode === "shadow"],
      ["B_FLAG", "2", "FLAG", mode === "shadow"],
      ["C_DOWNGRADE", "3", "DOWNGRADE", mode === "shadow"],
      ["D_BLOCK", "4", "BLOCK", mode === "shadow"],
      ["E_CRASH", "5", "BLOCK", mode === "shadow"],
    ]);
    repository.rows.forEach((row, index) => {
      expect(row.claimId).toBe(testClaimId);
      // IDs and UTC timestamps are assigned by the repository, not the pure runtime.
      expect(row).not.toHaveProperty("id");
      expect(row).not.toHaveProperty("createdAt");
      RuleFireSchema.parse({ ...row, id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, createdAt: "2026-10-01T00:00:00.000Z" });
    });
    expect(repository.rows[2]!.detailJson.linePatches).toEqual([{ lineIndex: 0, units: 1 }]);
    expect(repository.rows[4]!.detailJson).toMatchObject({ code: "RULE_CRASH", message: expect.stringContaining("E_CRASH") });
  });

  it("works without any repository or I/O", async () => {
    const ctx = makeContext();
    expect(await runRulesWithRepository(rules, ctx)).toEqual(runRules(rules, ctx));
  });

  it("does not call a repository for an empty pack", async () => {
    const repository = new MemoryRepository();
    const run = await runRulesWithRepository([], makeContext(), { claimId: testClaimId, repository });
    expect(repository.calls).toBe(0);
    expect(run.submissionAllowed).toBe(true);
  });

  it("propagates persistence failure rather than returning permission to submit", async () => {
    const repository: RuleFireRepository = { insertRuleFires: async () => { throw new Error("SYN audit unavailable"); } };
    await expect(runRulesWithRepository([rules[0]!], makeContext(), { claimId: testClaimId, repository })).rejects.toThrow("SYN audit unavailable");
  });

  it("validates the claim reference before attempting a write", async () => {
    const repository = new MemoryRepository();
    await expect(runRulesWithRepository(rules, makeContext(), { claimId: "not-a-uuid", repository })).rejects.toThrow();
    expect(repository.calls).toBe(0);
    expect(() => toRuleFireRows("not-a-uuid", runRules([], makeContext()))).toThrow();
  });

  it("produces detached, deterministic persistence rows without mutating the run", () => {
    const run = runRules(rules, makeContext());
    const before = structuredClone(run);
    const rows = toRuleFireRows(testClaimId, run);
    expect(toRuleFireRows(testClaimId, run)).toEqual(rows);
    rows[2]!.detailJson.linePatches = [];
    expect(run).toEqual(before);
    expect(toRuleFireRows(testClaimId, run)[2]!.detailJson.linePatches).toEqual([{ lineIndex: 0, units: 1 }]);
  });
});
