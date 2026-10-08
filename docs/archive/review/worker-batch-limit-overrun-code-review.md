# Code Review: worker-batch-limit-overrun
Date: 2026-10-08
Review round: 1

## Changes from Previous Round
Initial review. Phase 2 self-R-check found one Minor (R50), fixed in `b30dbf767`. Local LLM pre-screening and seeds were skipped, so each expert reviewed the full diff.

## Functionality Findings (code review round 1)

No findings.

Verified:
- C2 gate OK (1121 files), gate-selftest-coverage, and check-rls-read-context all pass.
- Unit suites pass: scripts (152), worker-policy-manifest (72), audit-outbox-worker plus the retention-gc sweeps (75), check-rls-read-context (43).
- M1–M15 outer predicates, RETURNING and the M9/M10 CTE order are preserved.
- `claimDeliveriesInTx` and `findMany` run in the same transaction.
- The assert is the first statement in every seam. The extra round-trip runs once per poll, which is negligible.
- When the assert throws, the error propagates as before.
- `ast-project` keeps its default for every adopter.
- The `sql-scan` edge cases are covered by tests.
- C2's failure modes work.
- C4 handles all four `sweepBounds:true` entries: anchor-publisher and chain-verify have no writes.
- Every Implementation Checklist file is in the diff.
- D-2 and D-3 are implemented.

Noted, not filed:
- `123E'foo'` lexing: the number tokenizer would swallow the `E`. This sequence does not occur in real SQL.
- The forward-reference check under `WITH RECURSIVE` is asymmetric. PostgreSQL rejects the case, and no member uses RECURSIVE.

## Seed Finding Disposition
Seed unavailable — no dispositions to record.

## Recurring Issue Check (Functionality expert)
R1 clean; R17 clean; R19 clean; R20 clean; R33 clean; R42 clean; R45 clean; R48 clean; RT6 clean; RT7 clean (D-1 recorded); RT9 clean. Other rows have no applicable pattern.

## Security Findings (code review round 1)

S-CR1-1 [Major] (R52/R49/R47/R29) — the shared scanner's write recogniser (scripts/checks/lib/sql-scan.mjs parseWriteHead; statement-position rule) knows only `DELETE FROM <t>` and `UPDATE <t> … SET`. C2 (check-limited-subquery-write.mjs: `writes.length === 0` ⇒ allow every LIMIT) and INV4 (worker-policy-manifest.test.ts: extract only when writes.length > 0; main used SWEEP_CANDIDATE_RE /DELETE FROM|\bUPDATE\s/ anywhere) therefore miss: MERGE (ON-clause IN (SELECT … LIMIT 2 FOR UPDATE SKIP LOCKED) → 3 rows; join-source form → 3 rows), INSERT … SELECT … IN (… LIMIT … FOR UPDATE SKIP LOCKED) ON CONFLICT DO UPDATE → 3 rows, an opaque-prefixed write (`${hint} UPDATE … WHERE id IN (SELECT … LIMIT $1 FOR UPDATE SKIP LOCKED)` — probe A shape), and WITH RECURSIVE … SEARCH … SET. INV4 silently drops these candidates (no current member lost: 25/25). D-2's "every real write statement has that form" and round-3 "MERGE stays bounded" are wrong. Fix: (a) recognise MERGE INTO with UPDATE/DELETE actions, INSERT … ON CONFLICT … DO UPDATE, and opaque-only predecessors as transparent at statement position; (b) fail closed on any remaining UPDATE/DELETE/MERGE word not classified as a write nor a known non-write (FOR [NO KEY] UPDATE, FK ON UPDATE|DELETE): C2 denies LIMIT/FETCH with UNRECOGNISED_WRITE, INV4 reports unbounded; (c) INV4 judges MERGE/upsert unbounded unless exempted; (d) correct D-2, gate header, review-log claim. Remedy floor: keep C1 members, standalone SELECT … FOR UPDATE … LIMIT, FK ON DELETE CASCADE text, D-2 prose rows, INSERT … DO NOTHING allowed; one deny row per new form in C2 and INV4 self-tests; red-prove each clause.

Verified clean: locking/rechecks for M1–M15 (EvalPlanQual), assertAuditWriteBypass placement in all ten seams, no seam sets GUCs, injection positions, raw-sql/bypass-rls/rls-read-context gates exit 0, ast-project R52, C4 accept side, 224/224 unit tests.
[Adjacent, not a finding] M11–M14 cutoff/guard not rechecked under EvalPlanQual — unchanged from before.

## Seed Finding Disposition
Seed unavailable — no dispositions to record.

## Recurring Issue Check (Security expert)
R1 OK; R3 OK; R5 OK; R16 OK; R17 OK; R20 OK; R29 S-CR1-1; R33 OK; R36 OK; R42 OK (M1–M15) / fires for write-form set (S-CR1-1); R44 OK; R45 OK; R46 OK; R47 S-CR1-1; R48 OK; R49 S-CR1-1; R50 OK; R52 S-CR1-1 (ast-project OK); R54 OK; R57 N/A; others N/A; RS3 OK; RS4 OK; RS1/RS2/RS5/RS6 N/A.

## Testing Findings (code review round 1)

T-CR1-1 [Major] (RT7) — src/__tests__/db-integration/audit-outbox-sweep-caps.integration.test.ts, FORCED_PLAN_MEMBERS entries for M5/M6 and the shared it.each body: per deviation D-1 these two cases pass against both the pre-fix and the C1 shape under today's indexes, but the test file does not say so; identically-worded test names imply all six are red-proven. Fix: an in-file comment on the M5/M6 entries stating they are post-fix cap assertions only and that C2 (check-limited-subquery-write.mjs) carries their regression protection.

Verified clean: 299/299 unit tests (audit-outbox-worker, check-limited-subquery-write, sql-scan, ast-project, worker-policy-manifest, three retention-gc sweep tests); withGucState throws on unmodelled $queryRaw and wraps every $transaction callback; guard tests snapshot before/after inside the holding tx; tied value bound once per INSERT…SELECT; isolate() neutralises and asserts zero before insert; forceRescanPlan SHOW-checks all five GUCs; C2/C4 deny+allow pairs incl. D-2/D-3; ast-project extension threading tests; pre-pr wiring; no mock-reset-in-body, unawaited calls or beforeAll per-test state.

## Seed Finding Disposition
Seed unavailable — no dispositions to record.

## Recurring Issue Check (Testing expert)
RT1 clean; RT2 N/A; RT4 clean; RT6 clean; RT7 T-CR1-1; RT9 clean; RT10 clean; RT11 clean; R16 clean; R19 clean; other R1-R57 / RT rows: no applicable pattern.

## Adjacent Findings
- Sec: the cutoff and guard of M11–M14 are not rechecked under EvalPlanQual. This was already true before the change. Not a finding.

## Environment Verification Report
- VE1 (integration, workers stopped): `verified-local`.
  - Batch A ran the audit-outbox suites: 12 files, 197 tests.
  - The orchestrator ran the retention-gc suites with `docker compose stop audit-outbox-worker retention-gc-worker && npx vitest run --config vitest.integration.config.ts <11 files>`: 48 tests.
- VE2 (worker bundle boot): `verified-local`. The pre-pr `Smoke: worker-bundle-boot` step was part of the 84/84 run.

## Resolution Status

### T-CR1-1 [Major] M5/M6 forced-plan rows not marked as post-fix only
- Action: a comment above `FORCED_PLAN_MEMBERS` states that M1–M4 overran pre-fix, while M5/M6 did not (deviation D-1). Their rows are post-fix cap assertions, and C2 catches a revert statically.
- Modified file: `src/__tests__/db-integration/audit-outbox-sweep-caps.integration.test.ts` (`FORCED_PLAN_MEMBERS`)

### S-CR1-1 [Major] write recogniser missed MERGE / upsert / opaque-prefixed / SEARCH-CYCLE writes
- Action: the scanner recognises MERGE (UPDATE/DELETE actions), upsert, opaque-prefixed writes and SEARCH/CYCLE.
  - Fail-closed `unrecognisedWrites` applies to parenthesised literals: C2 reports `UNRECOGNISED_WRITE`, and INV4 reports unbounded.
  - INV4 judges MERGE and upsert unbounded.
  - The gate header and deviation D-2 are corrected, and D-4 is added.
  - The plan-review round-3 claim "MERGE stays bounded" held only for a MERGE whose source is the LIMIT subquery. An ON-clause or join-source predicate overran (3/2).
  - Every clause was red-proven on throwaway copies.
- Modified files: `scripts/checks/lib/sql-scan.mjs`, `scripts/checks/check-limited-subquery-write.mjs`, `src/__tests__/workers/worker-policy-manifest.test.ts`, `scripts/__tests__/{sql-scan,check-limited-subquery-write}.test.mjs`
- Verification: 281/281 targeted tests; the gate is OK on the tree; raw-sql gate OK; tsc and eslint clean.

---

# Round 2
Date: 2026-10-08

## Changes from Previous Round
Reviewed the round-1 fixes: `55dde39ba` (M5/M6 test comment) and `f2a89e6d8` (S-CR1-1 write forms and fail-closed). Single reviewer, three expert sections. 264/264 targeted tests pass, the gate is OK on the tree, and INV4 extraction matches the old regex on the 8 modules (25/25).

R43 against the round-1 state: C2's denied set is a superset. The only widening is a correct one: a materialized CTE after a SEARCH/CYCLE comma is now parsed. INV4 is stricter or equal. Nothing moved from deny to allow.

## Functionality Findings
- **F-CR2-1 [Major]** `mergeActions` reads a top-level `CASE … WHEN … THEN` at MERGE depth as a MERGE WHEN clause. Consequences:
  - (a) A parenless writing MERGE is neither a write nor unrecognised, so INV4 drops it.
  - (b) A C1-shaped MERGE whose SET uses CASE is false-denied with UNRECOGNISED_WRITE.
  - (c) `WHEN MATCHED AND CASE WHEN c THEN insert END THEN UPDATE` reads as an INSERT action.
- **F-CR2-2 [Major]** (R48/R52) INV4 inherits the parenthesis gate on `unrecognisedWrites`. That gate is valid only for C2's LIMIT question. Parenless unbounded writes (`EXPLAIN ANALYZE DELETE …`, `PREPARE … AS DELETE …`, the F-CR2-1 MERGE) drop out of INV4, so as a class its extraction is narrower than main's regex. Ungated, INV4 has 0 unrecognised literals on the 8 modules.
- **F-CR2-3 [Minor]** An upsert whose INSERT source has a top-level LIMIT is denied with a "rescanned per row" rationale that does not apply.
- **F-CR2-4 [Minor]** The gate's own stderr literals sit on its false-deny boundary. Prose with a parenthesis plus LIMIT plus a write word would deny with SQL remediation text.

## Security Findings
No findings. Checked:
- the parenthesis justification for C2;
- INSERT-only MERGE plus a second statement;
- `ON UPDATE|DELETE`;
- `DO UPDATE` in comments and strings;
- opaque `${…}` between UPDATE and SET.

[Adjacent] F-CR2-2 is the security-relevant item.

## Testing Findings
- **T-CR2-1 [Minor]** INV4 `WRITE_FORM_DENY` rows that contain a parenthesis pass through the unrecognised-write backstop, not through the clause they name. A mutant scanner without `skipSearchCycle` or the opaque skip stays green.

## Recurring Issue Check
R29 (the 25/25 figure is a point measurement), R42 (MERGE with CASE), R47, R48, R49, R52, RT7 fire as above. R43 and R50 OK. Other rows N/A or clean.

## Resolution Status (round 2)
Every round-2 finding was fixed in one commit and red-proven on throwaway copies (`scratchpad/cr2fix/`, mutants M1–M8).

### F-CR2-1 [Major] CASE read as a MERGE WHEN
- Action: `clauseWordAt` skips `CASE … END` at MERGE depth, counting nested CASEs. An unbalanced CASE or a stray END returns null.
- Rows added:
  - scanner: CASE in SET, CASE in the WHEN condition (case c), nested CASE, CASE in ON, unbalanced;
  - C2: a deny row with CASE plus a LIMIT in ON; an allow row for the C1-shaped MERGE with CASE;
  - INV4: a deny row for the parenless CASE MERGE.
- Red proof: M1 (drop the CASE skip) turns those 8 rows red and leaves the existing MERGE rows green.
- Modified file: `scripts/checks/lib/sql-scan.mjs` (`clauseWordAt`, `mergeActions`)

### F-CR2-2 [Major] INV4 inherited the C2-only parenthesis gate
- Action: `unrecognisedWrites` is ungated, and `hasParenGroup` is exposed. C2's `deniedLimits` requires both. INV4 uses the ungated list.
- Rows added: INV4 deny rows for parenless `EXPLAIN ANALYZE DELETE` and `PREPARE … AS DELETE`.
- Red proof:
  - M2 (re-gate INV4): 6 rows red;
  - M3 (un-gate C2): the C2 prose rows and the no-parenthesis bypass row red.
- Measurement: 25 candidates and 0 unrecognised on the 8 modules.
- Modified files: `sql-scan.mjs`, `check-limited-subquery-write.mjs`, `worker-policy-manifest.test.ts`

### F-CR2-3 [Minor] Upsert rationale
- Action: the header and message say the upsert source LIMIT is denied by policy (one shape across the class), not because it is rescanned.

### F-CR2-4 [Minor] The gate's own message literals
- Action: a comment beside `C1_SHAPE` states the self-scan constraint, and the message is reworded. The UNRECOGNISED_WRITE help now covers messages or log lines that hold a parenthesis, and a deny row pins it.

### T-CR2-1 [Minor] INV4 deny rows pinned to their clause
- Action: each `WRITE_FORM_DENY` row asserts its detail prefix.
- Red proof: M4 (no `skipSearchCycle`), M5 (no opaque skip) and M6 (the reviewer's mutant) are now red.

Verification: 295/295 tests across 4 targeted files; the gate is OK on the tree; raw-sql gate OK; tsc and eslint clean.

---

# Round 3
Date: 2026-10-08

## Changes from Previous Round
Reviewed `c9c7ff1ce`, the round-2 fixes. All of them are correct and introduce no fail-open regression.

R43 against the round-2 state:
- C2: the only deny-to-allow change is the intended C1-shaped MERGE with a balanced CASE.
- INV4: extraction is a superset of round 2. An INSERT-only MERGE containing a CASE now reads as a known non-write, which aligns it with the case without CASE.

The reviewer re-measured 25 candidates and 0 unrecognised on the 8 modules, and the M1 mutant came back red.

## Functionality Findings
- **F-CR3-1 [Minor, class (i), local]** (R47) `clauseWordAt` counted a dotted reserved-word column (`p.end`, `u.case`) or a label (`AS end`) as CASE/END. The result was that a correct C1-shaped MERGE was falsely denied with UNRECOGNISED_WRITE. This fails closed.
- **F-CR3-2 [Minor, class (i), local]** (R52) Ungated INV4 extraction reads prose, module specifiers and literal types. These cannot be exempted, and the violation detail gave no remedy. The 8 modules hold none today.

## Security Findings
No findings. Checked: C2 still decides the same way after the paren gate moved; a MERGE action cannot hide behind CASE, a dotted name or `${…}`; exemption matching on newly extracted literals.

## Testing Findings
No findings. The WRITE_FORM_DENY detail pins work, and the scanner CASE rows separate nesting, a stray END and an unclosed CASE.

## Resolution Status (round 3)
### F-CR3-1 [Minor]
- Action: in `clauseWordAt`, a word right after `.` or `AS` is not counted as a keyword.
- Scanner rows added: `u.end` in SET, `u.case` in a WHEN condition, `RETURNING … AS end`.
- Red proof: removing the skip on a throwaway copy turns the new row red (1 of 71).
- Modified files: `scripts/checks/lib/sql-scan.mjs` (`clauseWordAt`), `scripts/__tests__/sql-scan.test.mjs`
### F-CR3-2 [Minor]
- Action: the INV4 unrecognised-write detail now says to reword or move a message/identifier literal, and that an exemption cannot cover it.
- The optional narrowing (skipping module specifiers and literal-type positions) was not done.

#### F-CR3-2 optional narrowing — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a future import specifier or literal type in one of the 8 worker modules that contains `update`/`delete`/`merge` fails INV4. That failure is loud and fail-closed, and the detail now gives the remedy.
  - Likelihood: low. No such literal exists today; 15 near-misses do not trip.
  - Cost to fix: about 30 lines of AST position classification plus rows, on a security test, for a false deny that cannot hide a write.
- **Orchestrator sign-off**: false-deny only; no exposure.

Verification: 279/279 targeted tests; the gate is OK on the tree; eslint and tsc are clean.

---

# Round 4
Date: 2026-10-08

Reviewed `7f53fa153`. Functionality, security and testing all report no findings.

- The DOT/AS skip cannot hide a real keyword. In PostgreSQL, the token after `AS` (ColLabel) or after `.` (attribute name) is always a name, even when it is a reserved word.
- `CAST(… AS …)` sits one parenthesis level deeper and is filtered by depth.
- A masking attempt over an unbalanced CASE still fails closed.
- R43: no widening beyond F-CR3-1's false-deny scope.
- RT7: the reviewer reproduced the red proof independently.
- Verification: 279/279 targeted tests; the gate is OK on the tree.

Review loop closed after 4 rounds.
