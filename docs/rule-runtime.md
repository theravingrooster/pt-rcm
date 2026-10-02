# Rule runtime

`@pt-rcm/rules` exports `Rule`, `RuleContext`, `RuleResult`, `runRules`, and
`applyDowngrades`. A rule has a stable string ID, positive integer version,
description, and synchronous pure `evaluate(ctx)` function. Results use the
`outcome` discriminator: `PASS`, `FLAG`, `DOWNGRADE`, or `BLOCK`.

`RuleContext` contains the canonical encounter, minute lines, `UnitAllocation`,
coverage (nullable), payer, authorizations, plan of care (nullable),
`yearToDateBilledCents` for that patient+payer and service year, and mode
`active` or `shadow`. Callers supply the data; the runtime does not load it or
recalculate allocation. Each rule sees the same deeply frozen copy.

`runRules(rules, ctx)` is synchronous and performs no I/O. It runs every rule in
ID order, then numeric version order for equal IDs. `findings` includes one entry
per rule, including PASS. Throws and malformed or unsafe results become BLOCK
findings with code `RULE_CRASH` and the rule ID; later rules still run.

`blocks` and `downgrades` contain active findings only. Shadow findings retain
their original outcome and `shadow: true`, but both actionable lists are empty.
`submissionAllowed` is exactly `blocks.length === 0`; it never submits anything.

Downgrade patches are `{ lineIndex, units }`, specifying absolute unit ceilings.
The draft must retain the allocation's line order, including zero-unit lines.
`applyDowngrades(draft, run.downgrades)` returns a detached, unpriced claim draft
and changes only units. Multiple proposals use the lowest ceiling. Unknown
lines, unit increases, changes to clinical facts, and a different encounter ID
are rejected. Shadow proposals are ignored. Zero-unit lines remain for caller
review; pricing and conversion into persisted claim lines are separate work.

`runRulesWithRepository(rules, ctx, { claimId, repository })` is the optional I/O
wrapper. Without that third argument it just returns the pure run. With it,
`insertRuleFires` receives one atomic batch, including PASS, crashes, and shadow
findings. Write failures reject the operation. `toRuleFireRows` is the pure row
converter; numeric rule versions become text for the existing RuleFire schema.
Repositories assign IDs and UTC timestamps. `createRuleFireRepository(db)` from
`@pt-rcm/db` supplies the Drizzle adapter and accepts an existing transaction.
The rules package does not import the database package.

The default rule pack is empty. `src/testing/alwaysFlag.ts` contains the
`ALWAYS_FLAG` example for tests only, with no public export or registration.
No PT policy rules or clearinghouse integration are included.
