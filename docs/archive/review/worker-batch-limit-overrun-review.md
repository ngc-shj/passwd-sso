# Plan Review: worker-batch-limit-overrun
Date: 2026-10-08
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening skipped.

## Merged findings (deduplicated)

- **P1 [Major, convergent: Func F1 + Sec S1]** design (R42/R52/R48). The existing sweepBounds guard (`worker-policy-manifest.test.ts` assertion 12, `isKeySetLimited`) requires the pre-fix contiguous shape, so C1 would turn all 15 members red. It is also already fail-open on a CTE: the lazy match crosses the IN group's closing paren. The plan omitted it, along with `sweep-access-request-expiry.test.ts` and the manifest's "idempotent" prose.
- **P2 [Major, convergent: Func F2 + Sec S2]** design (R29/R47/R49). C2's stated regex matches none of the real pre-fix members, because `now()` / `make_interval()` put parentheses before `LIMIT`. Its bypass list leaves out `= ANY (SELECT … LIMIT … FOR UPDATE)`, which was probed and updated 3 rows. It also lists `ANY(ARRAY(SELECT …))`, an InitPlan that is evaluated once and is not in the class. FROM/USING subqueries are unlisted.
- **P3 [Critical] Test T1** design (R41). M1 `claimBatch` is module-private, so there is no test seam.
- **P4 [Critical] Test T2** design (RT4). The dedicated-client tests need committed rows on global queries, so ambient eligible rows make the exact-cap assertion nondeterministic.
- **P5 [Minor] Sec S3** (R49). R2 claims C2 pins MATERIALIZED, but a lock-free CTE without MATERIALIZED is inlined back into the old plan (probe F). Locking CTEs are never inlined.
- **P6 [Minor] Sec S4** (R52/R36). C2 must not spell the raw-sql names as literals or widen `check-raw-sql-usage` exemptions.
- **P7 [Minor] Test T3** (RT10). No self-test row pins each declared bypass.
- **P8 [Minor] Test T4**. Driving M2/M3 through the full process functions triggers delivery attempts.
- **P9 [Minor] Func F3** (R29). M12 is `sweepGuardedExpiryEntry`.
- **P10 [Minor] Func F4** (R29). The probe scripts are not in the repo.

## Raw expert outputs
## Functionality Findings (round 1)

F1 [Major] design (R42) — C1's CTE rewrite breaks the existing sweepBounds CI gate (worker-policy-manifest.test.ts assertion 12, INV4, regex at ~line 249 requiring contiguous WHERE <keys> IN (SELECT <keys> FROM … LIMIT …)); all M1–M15 would be flagged unbounded; sweep.ts:627-636 comment on M15 documents this dependency; manifest exemptions would strip coverage. Fix: extend isKeySetLimited/extractSweepStatements to recognise WITH <cte> AS MATERIALIZED (… LIMIT …) … WHERE (<keys>) IN (SELECT <keys> FROM <cte>), red/green against both shapes, verify against all four sweepBounds:true manifest entries.

F2 [Major] design (R29) — C2's stated forbidden-pattern regex `\bIN\s*\(\s*SELECT\b[^()]*\bLIMIT\b` returns false on real M1/M11/M15 SQL (now(), make_interval(...) parens before LIMIT). Fix: specify parenthesis-depth-aware logic, not a regex.

F3 [Minor] prose (R29) — M12 is `sweepGuardedExpiryEntry`, not `sweepExpiryGuardedEntry`.

F4 [Minor] prose (R29) — probe scripts are in the session scratchpad, not the repo; commit them or state the CI flake as sufficient corroboration.

## Recurring Issue Check (Functionality expert)
R1-R28 N/A (plan, no diff); R29 fires (F2,F3,F4); R30-R41 N/A; R42 fires (F1); R43-R48 N/A; R49 adjacent to F1; R50-R57 N/A.

## Security Findings (round 1)

S1 [Major] design (R42/R52/R36) — src/__tests__/workers/worker-policy-manifest.test.ts assertion 12 (sweepBounds, INV4) `isKeySetLimited` regex requires contiguous `WHERE <keys> IN (SELECT <keys> FROM … LIMIT …)`; C1 shapes return false (all 15 become "unbounded"); regex already fail-open for a CTE (lazy `[\s\S]*?\bLIMIT\b` crosses the IN group's paren: CTE without LIMIT + NOT EXISTS(… LIMIT 1) → true). Plan omits this guard, sweep-access-request-expiry.test.ts and worker-policy-manifest.json "idempotent" prose. Fix: accept CTE form only when IN keys == SELECT keys FROM <cte>, cte declared AS MATERIALIZED in same WITH list, body selects same keys from the statement's own table with top-level LIMIT; bound contiguous match to IN group's paren level; deny/allow pairs; update manifest prose.

S2 [Major] design/prose (R49/R29/R47) — `= ANY (SELECT … LIMIT 2 FOR UPDATE SKIP LOCKED)` updated 3 rows (probe C, Nested Loop Semi Join over ANY_subquery); not matched by C2 nor listed. Listed bypass `= ANY(ARRAY(SELECT …))` is an InitPlan, evaluated once (2 rows) — not a member. `UPDATE … FROM (SELECT … LIMIT) s` / `DELETE … USING (…)` unlisted, inner rescan unproven. Fix: extend deny to `<op> ANY|SOME ( SELECT`; deny or honestly list FROM/USING subquery with top-level LIMIT; remove ARRAY form from bypass list; self-test pairs.

S3 [Minor] prose/design (R49) — Risk R2 claims C2 pins MATERIALIZED, but C2 does not inspect CTEs. Lock-free CTE without MATERIALIZED is inlined back into the old shape (probe F); locking CTEs are never inlined. Fix: C2 deny rule for non-MATERIALIZED CTE with top-level LIMIT read by IN, or reword R2.

S4 [Minor] design (R52/R36) — C2 must read template literals generically and never spell renderSql/trustedSql/sqlIdentifier/joinSql as literals (check-raw-sql-usage.mjs checkRawSqlNameLiterals); raw-sql gate exemptions unchanged.

Checked clean: locks held until commit (probe4), outer `status='PENDING'` recheck via EvalPlanQual, M15 CAS preserved, audit completeness, RLS/bypass GUCs, #635 gate passes if statements stay in existing positions; byte-for-byte fix without tiebreaker re-probed: 2 rows.

Member set recomputed: 10 hits audit-outbox-worker.ts (131,684,958,1382,1470,1533,1611,1632,1688,1730), 5 sweep.ts (192,230,305,441,656); no ANY/USING/FROM/ARRAY spellings in production; no migration bounded writes; no take/limit on updateMany/deleteMany.

## Recurring Issue Check (Security expert)
R1 N/A; R2 N/A; R3 S1; R4 N/A; R5 OK; R6 N/A; R7 N/A; R8 N/A; R9 OK; R10-R13 N/A; R14 OK; R15 N/A; R16 OK; R17-R19 N/A; R20 keep outer predicates/RETURNING; R21 N/A; R22 OK; R23-R28 N/A; R29 S2; R30 N/A; R31 OK; R32 OK; R33 mirror registration; R34 S1; R35 N/A; R36 S1,S4; R37-R41 N/A; R42 S1; R43 N/A; R44 OK; R45 not measured; R46 N/A; R47 S2,S3; R48 S1; R49 S2,S3; R50 OK; R51 N/A; R52 S1,S4; R53 N/A; R54 OK; R55-R57 N/A; RS1 N/A; RS2 N/A; RS3 OK; RS4 OK; RS5 N/A; RS6 N/A.

## Testing Findings (round 1)

T1 [Critical] design (R41/RT2) — claimBatch (M1) is module-private, reachable only via createWorker() closure; no seam. Fix: export an InTx seam mirroring reapStuckRowsInTx.

T2 [Critical] design (RT4) — processDeliveryBatch, processWebhookDeliveryBatch, reapStuckWebhookDeliveries, reapStuckDeliveries wrapper open their own transaction; a dedicated-client test needs committed rows, and the queries are global (not tenant-scoped), so ambient eligible rows from earlier files make the exact-cap assertion nondeterministic. Fix: export InTx seams for M2/M3/M6, test M5 via reapStuckDeliveriesInTx, rollback-fenced; pair with an allow-side case.

T3 [Minor] design (RT10) — C2 self-test has no row per named bypass pinning the blind spot. Fix: one row per bypass.

T4 [Minor] design — M2/M3 via the full process functions trigger real delivery attempts; fixture targets must fail fast, or avoid the path.

Feasibility confirmed: `options=-c …` passes through pg; createPrismaForRole supports max:1; M4/M5 InTx + runInRolledBackTx reusable with SET LOCAL; maxWorkers:1; static-checks runs pre-pr.sh in PRE_PR_STATIC_ONLY mode so pre-pr wiring reaches CI; C2 self-test layout matches check-raw-sql-usage.test.mjs.

## Recurring Issue Check (Testing expert)
R1-R15 N/A; R16 subsumed in T2; R17-R31 N/A; R32 not fired (VE2); R33-R40 N/A; R41 T1; R42 not fired; R43-R46 N/A; R47 N/A; R48 N/A; R49 N/A; R50-R57 N/A; RT1 not new (two-tier convention); RT2 T1; RT3 N/A; RT4 T2; RT5 OK where testable; RT6 N/A; RT7 not new; RT8 N/A; RT9 N/A; RT10 T3; RT11 N/A.

## Resolution (plan revision 2)
- P1: new contract C4 rewrites `isKeySetLimited` against the CTE form under the rules from S1, bounds the match to the IN group's parenthesis level, adds deny/allow pairs, and updates the manifest prose and the M15 comment. C2 and C4 share one paren-aware SQL scanner (R48).
- P2: C2 is specified by parenthesis depth, not by a regex. It denies IN / `<op> ANY|SOME` groups and FROM/USING subqueries with a top-level LIMIT, and allows ARRAY(SELECT). The bypass list is corrected.
- P3/P4/P8: C3 drops the dedicated client. Exported InTx seams are added for M1, M2, M3 and M6 (M4/M5 already have them). Every locking-member test is rollback-fenced and neutralises ambient eligible rows inside its own transaction.
- P5: C2 denies a non-MATERIALIZED CTE with a top-level LIMIT that an UPDATE/DELETE reads. R2 is reworded.
- P6: stated in C2.
- P7: one self-test row per declared bypass.
- P9: fixed.
- P10: the probe is committed as `docs/archive/review/worker-batch-limit-overrun-probe.sql`.

---

# Round 2
Date: 2026-10-08

## Changes from Previous Round
Plan revision 2: C2 rewritten by parenthesis depth, C3 moved to InTx seams with rollback-fenced tests, C4 added for sweepBounds, and the probe committed.

## Merged findings
- **Q1 [Critical] Test T-F1** (RT4/RT7/R50/R29). The overrun reproduces only with tied ORDER BY values plus a lock. With distinct values the result is 2. The plan's "ties are not the mechanism" is wrong.
- **Q2 [Major] Sec S5** (R49/R46/R47/R34). C4's CTE acceptance passes unbounded statements: H (OR), I (UNION), J (nested-scope shadowing), K (a second write in the literal), R (a non-key column) and M (LIMIT ALL).
- **Q3 [Major] Sec S6** (R49/R48). A correlated `ANY(ARRAY(SELECT … LIMIT … FOR UPDATE))` is a per-row SubPlan and overran. C2's allow set is wider than C4's accept set.
- **Q4 [Major] Test T-F2** (R42). The neutralisation mechanism is unnamed, and a DELETE is blocked by the audit_outbox delete guard.
- **Q5 [Minor] Sec S7** (R47/R49/R29). These overran and C2 missed them: `IN ((SELECT …))`, `IN (WITH … SELECT …)`, `FETCH FIRST`, and a derived-table LIMIT inside IN. The "no overrun shown" claim for FROM-subqueries is refuted (T).
- **Q6 [Minor] Sec S8** (R54/R52). The new seams would set the RLS bypass on the caller's transaction.
- **Q7 [Minor] Sec S9** (R31/R36/RT11). Pin the neutralisation as an UPDATE of the eligibility column through the tx handle. Same subject as Q4.
- **Q8 [Minor] Func F1-R2** (R29). The manifest doc fields cite line ranges that C1 will shift.
- **Q9 [Minor, Adjacent] Test T-ADJ1**. A residual TOCTOU on a live dev DB. Accepted, the same class as the existing reaper tests.

## Raw expert outputs
## Functionality Findings (round 2)

Verified: probe output matches (A3 B3 C2 D2 E3 F2); F1-F4/P1-P10 resolved; seam names collision-free; precedent for importing scripts/checks/*.mjs from a TS test: src/__tests__/checks/crypto-auth-deps-manifest.test.ts:31 (scripts/checks/lib/ast-project.mjs); all 4 sweepBounds:true entries checked (anchor-publisher, chain-verify-worker extract zero writes).

F1-R2 [Minor] prose (R29) — C1 shifts line numbers; worker-policy-manifest.json doc fields cite line ranges beyond the one named (audit-outbox-worker idempotent / poisonMessageHandling; retention-gc-worker retryPolicy / poisonMessageHandling). Fix: re-derive every line citation in both entries, preferably citing subjects.

## Recurring Issue Check (Functionality expert, round 2)
R1-R28 N/A; R29 F1-R2; R30-R41 N/A; R42 OK; R43-R46 N/A; R47 OK; R48 OK; R49 OK; R50-R57 N/A.

## Security Findings (round 2)

S5 [Major] design (R49/R46/R47/R34) — C4's four CTE-acceptance conditions pass unbounded statements (each probed, 3 of 3 rows): H `IN (SELECT id FROM picked) OR …`; I `IN (SELECT id FROM picked UNION SELECT …)`; J nested-scope shadowing of `picked` (R46), J2 `IN (WITH picked AS (…) SELECT …)`; K bounded CTE write plus a second unbounded top-level write in one literal; R non-key column (`tenant_id`); M `LIMIT ALL`. H/K/R exist in today's regex too. Fix: per-write acceptance; IN as top-level AND conjunct; IN body exactly `SELECT <keys> FROM <cte>`; resolve cte to nearest enclosing WITH scope; keys = pkColumnsOf(table) or identical `${…}`; deny LIMIT ALL/NULL; deny pairs H,I,J,K,R,M.

S6 [Major] design (R49/R48) — correlated `= ANY (ARRAY(SELECT … WHERE t2.tenant_id = o.tenant_id … LIMIT 2 FOR UPDATE SKIP LOCKED))` is a per-row SubPlan and updated 3 (Q); uncorrelated gave 2 (U). C2 allow set wider than C4 accept set. Fix: deny ANY|SOME (ARRAY(SELECT … LIMIT …)) in writes (0 production uses); C2 allow set == C4 accept set.

S7 [Minor] design/prose (R47/R49/R29) — overran (3): N `IN ((SELECT …))`; P `IN (WITH q AS (…) SELECT … LIMIT …)`; O `FETCH FIRST 2 ROWS ONLY`; T `IN (SELECT id FROM (SELECT … LIMIT 2 FOR UPDATE SKIP LOCKED) s)` — refutes "no overrun shown" for FROM-subqueries. "contains UPDATE" also fires on FOR UPDATE / FOR NO KEY UPDATE (conservative, 0 hits) — state it.

S8 [Minor] design (R54/R52) — new exported InTx seams following reapStuckRowsInTx would set app.bypass_rls on the caller's tx (set_config local); no import boundary from src/app|lib to src/workers; check-bypass-rls is per-file. Fix (preferred): new seams assert current_setting('app.bypass_rls', true)='on' and purpose, throw otherwise; wrappers keep setBypassRlsGucs. claimDeliveriesInTx returning ids only is right; reapStuckWebhookDeliveriesInTx must keep writeDirectAuditLogInTx inside.

S9 [Minor] design (R31/R36/RT11) — no UPDATE triggers / FK refs on the three tables; audit_outbox has a BEFORE DELETE guard. Pin neutralisation: UPDATE of eligibility column only (next_retry_at='infinity' for PENDING, processing_started_at=now() for PROCESSING) through the tx handle; never DELETE, status change, trigger/replication-role change, or ctx.su.prisma.

Clean: clause 3 denies a locking CTE needlessly (G2 gave 2) — acceptable as single-shape choice, reword rationale; MATERIALIZED test must be token-exact (AS NOT MATERIALIZED); ARRAY inside IN body safe; outer write reading another source stays bounded; no injection change.

## Recurring Issue Check (Security expert, round 2)
R1 N/A; R2 N/A; R3 S5; R4 N/A; R5 OK; R6-R8 N/A; R9 OK; R10-R13 N/A; R14 OK; R15 N/A; R16 OK; R17-R19 N/A; R20 OK; R21 N/A; R22 OK; R23-R28 N/A; R29 S7; R30 N/A; R31 S9; R32 OK; R33 OK; R34 S5; R35 N/A; R36 S9; R37-R41 N/A; R42 OK; R43 N/A; R44 OK; R45 not measured; R46 S5; R47 S5,S7; R48 S6; R49 S5,S6,S7; R50 OK; R51 N/A; R52 S8; R53 N/A; R54 S8; R55-R57 N/A; RS1-RS3 N/A; RS4 OK; RS5-RS6 N/A.

## Testing Findings (round 2)

T-F1 [Critical] design (RT4/RT7/R50/R29) — forced-plan overrun reproduces only when the limit+1 rows share one ORDER BY value: M1 claim shape distinct created_at → 2, tied → 3; M4 distinct → 2, tied → 3; M3 tied → 3. The plan's "ties are not the mechanism" is wrong as stated; the outer status='PENDING' recheck does not prevent the overrun with ties. Fix: C3 fixtures bind one precomputed value for the member's ORDER BY column across all rows; a deviation entry only after confirming ties were used.

T-F2 [Major] design (R42) — neutralisation mechanism/column unnamed; audit_outbox BEFORE DELETE guard blocks DELETE of PENDING/PROCESSING (M1, M4). UPDATE of next_retry_at / processing_started_at is unobstructed on all three tables. Fix: name per-table UPDATE columns; never DELETE.

T-ADJ1 [Minor, Adjacent] — residual TOCTOU between ambient recheck and the forced-plan statement on a live dev DB (READ COMMITTED); immaterial in CI; same accepted class as existing reaper tests.

Verified: SET LOCAL + SHOW in runInRolledBackTx (single connection, superuser); C2/C4 self-tests already specify RT7/RT10; RT5 satisfiable via seams.

## Recurring Issue Check (Testing expert, round 2)
R1-R28 N/A; R29 T-F1; R30-R41 N/A; R42 T-F2; R43-R49 N/A; R50 T-F1; R51-R57 N/A; RT1-RT3 N/A; RT4 T-F1; RT5 OK; RT6 OK; RT7 T-F1; RT8 N/A; RT9 N/A; RT10 OK; RT11 N/A.

## Resolution (plan revision 3)
- Q1: the probe table and mechanism prose are corrected (lock plus tied ordering values). C3 fixtures bind one precomputed value for the ORDER BY column. A deviation entry is allowed only after a tied attempt.
- Q2/Q3/Q5: the gate design changes from enumerating shapes to refusing the class. C2: in a write statement, a `LIMIT`/`FETCH` token anywhere other than the top level of an `AS MATERIALIZED (…)` CTE body denies. That covers ANY, ARRAY (correlated or not), nested and derived tables, FROM/USING, `IN ((…))`, `IN (WITH …)` and non-materialized CTEs with one rule. C4 accepts a CTE form only when the IN body is exactly `SELECT <keys> FROM <cte>`, the IN is a top-level AND conjunct of the write's WHERE, the keys are the table's primary key (or the identical `${…}` text), and `LIMIT ALL`/`NULL` is denied. C4 is re-declared as a best-effort tripwire, which is what the existing regex already was. J (nested-scope shadowing) and K (a second unbounded write in one literal) are declared residuals with pinned allow rows.
- Q4/Q7: neutralisation is an UPDATE of the member's eligibility column through the tx handle (`next_retry_at = 'infinity'` for PENDING members, `processing_started_at = now()` for PROCESSING members). It never deletes, never changes status, never touches triggers or the replication role, and never commits.
- Q6: the new seams assert the bypass GUCs are already set and throw otherwise. The wrappers keep `setBypassRlsGucs`.
- Q8: every line-range citation in both manifest entries is replaced by a subject citation.
- Q9: accepted, noted in C3.

---

# Round 3
Date: 2026-10-08

## Changes from Previous Round
Plan revision 3:
- C2 became one class rule: a LIMIT or FETCH is allowed only at the top of a materialized CTE body.
- C4 was re-declared as a tripwire, with tighter acceptance and the residuals J and K.
- C3 now pins tied fixtures and the neutralisation step, and the seams assert the GUCs rather than set them.

## Merged findings
- **U1 [Critical] Test F-T1** (RT7/R54). No test proves the seam's assert-and-throw guard fires. The purpose GUC in the assertion is unresolved.
- **U2 [Major] Sec S10** (R47/R49/R48). C2 allows a materialized CTE nested inside an expression subquery. The correlated V2/V3 forms overran: 3 rows. The CTE must be in the write statement's own (depth-0) WITH list, and C2's allow set should be a subset of C4's accept set.
- **U3 [Major] Sec S11** (R29/R50). Probe G/H renumbered 0 rows: `created_at` is `timestamptz(3)` and `now()` carries microseconds, so the cases were never distinct. The mechanism is established: on a rescan, LockRows skips a tuple the current command already modified (TM_SelfModified), and LIMIT admits the next row. The outer scan updates that row when heap order matches the ORDER BY. Ascending gives 3, descending gives 2, and lock-free gives 2. Ties always line up, because a btree orders equal keys by heap TID.
- **U4 [Major, convergent: Func F1 + Sec S13]** (R54/R49/R42). Assert-only covers only the new seams. M4, M5, M9 and M10 still set the bypass GUCs on the caller's transaction.
- **U5 [Major] Test F-T2** (R42/R49/RT10). C4 pairs omit `LIMIT NULL`, a join, and a second FROM item.
- **U6 [Major] Test F-T3** (R42). M7 and M8 have no real-DB exact-cap test.
- **U7 [Minor] Sec S12** (R48/R46). `tableOf` resolves `SKIP` from `FOR UPDATE SKIP LOCKED` under C1, and `SWEEP_CANDIDATE_RE` is case-sensitive. Both should come from the scanner.
- **U8 [Minor] Test F-T4** (R29). The deviation-log location is unspecified.
- **U9 [Minor] Func F2** (R29). The contiguity comment on `sweepExpiredAccessRequests` goes stale under C4, as does the same wording in `sweep-access-request-expiry.test.ts`.

Verified clean this round:
- No non-member literal would be falsely denied by C2.
- Every C1 member satisfies C2 and C4.
- The neutralisation columns make each predicate false.
- `runInRolledBackTx` sets the bypass GUCs.
- C4 as a tripwire is honest, and nothing relies on it as a boundary.
- MERGE stays bounded.

## Resolution (plan revision 4)
- U1: one shared assert helper is used by every seam. One throw test per seam covers GUC unset and wrong purpose. The assertion covers `app.bypass_rls = 'on'` and `app.bypass_purpose = AUDIT_WRITE`. `app.tenant_id` is not asserted, because no member reads it.
- U2: C2 accepts a LIMIT only in a CTE of the WITH list at literal depth 0. V1, V2 and V3 are deny rows. C2's allow set is stated as a subset of C4's accept set.
- U3: the probe G/H cases are rebuilt with directly inserted distinct values (re-run: G 3, H 2), and the mechanism prose is replaced.
- U4: M4, M5, M9 and M10 become assert-only, and their wrappers set the GUCs. Other self-setting functions are SC3: `deliverRow`, `checkChainEnabled` and `deliverRowWithChain` (outside the class), and M12/M15 (called by the retention-gc runner, not exposed as seams).
- U5: deny rows are added for `LIMIT NULL`, a join and a second FROM item.
- U6: new seams for M7 and M8, with rollback-fenced exact-cap tests.
- U7: the target table and candidate set come from the scanner's statement-level write keyword, with a pair each for a `FOR UPDATE` C1 shape on a `PK_BY_TABLE` override table and for a lowercase write.
- U8: deviation entries go to `docs/archive/review/worker-batch-limit-overrun-deviation.md`.
- U9: both comments are added to C4's touch list.

---

# Round 4
Date: 2026-10-08

## Changes from Previous Round
Plan revision 4:
- C2 anchors the CTE at the literal's depth 0.
- The mechanism is established, and the probe now covers G (ascending) and H (descending).
- All ten seams are assert-only.
- M7 and M8 have seams and cap tests.
- C4 gained pairs and takes its table and statements from the scanner.

## Findings (single reviewer, three expert sections)
- **Test-1 [Major] design** (R19/RT1/RT10). The unit transaction mocks cannot answer the assert, which makes the negative tests vacuous. Nothing proves that `claimBatch` (M1) sets the GUCs before calling its seam, and its failure is swallowed in production.
- **Test-2 [Minor] design** (RT8). The guard tests assert the throw, not "before touching any row".
- **Test-3 [Minor] design** (R41/RT7). C2 claims seven extensions, but the shared AST helper scans only `.ts`/`.tsx`. There is no per-extension row.
- **Func-1 / Sec-1 [Minor] prose** (R29/R42/R54). The SC3 member set is wrong. `deliverRow` and its siblings open their own transactions. M11, M13, M14 and `sweepAuditLogs` were omitted.
- **Func-2 [Minor] prose** (R29/R49). "C2 allow set ⊆ C4 accept set" is false as worded.
- **Func-3 [Minor] prose** (R29). A scanner placed at `scripts/checks/*.mjs` trips `check-gate-selftest-coverage.sh`. It belongs in `scripts/checks/lib/`.
- **Sec-2 [Minor] prose** (R29). "No member reads `app.tenant_id`" is false: the RLS policy cast reads it and fails closed with 22P02.
- **Sec-3 [Minor] prose** (R49). The `${…}` key identity in C4 is an undeclared residual.

Verified clean:
- The probe re-run matches the header.
- Production reaches the seams only through wrappers.
- The M7/M8 signatures match `purgeRetention`.
- C2's depth-0 rule closes V1–V3.
- The purpose check matches both helpers.

## Resolution (plan revision 5)
- Test-1: transaction mocks model the GUC state, and every wrapper gets a unit test that the GUCs are set before the seam's statement is issued. The `claimBatch` red proof is required, and the file is re-checked for vacuous negatives.
- Test-2: the guard tests re-read the fixture rows after catching the throw. Red proof: move the assert below the write.
- Test-3: C2 does not reuse `isScannableSourceFile`, and there is one deny fixture per extension.
- Func-1/Sec-1: SC3 is re-derived by grep (M11–M15 and `sweepAuditLogs`), with the reason given as the `sweepOnce` dispatch.
- Func-2: narrowed to LIMIT positions.
- Func-3: the scanner moves to `scripts/checks/lib/` with its own unit tests.
- Sec-2: the reason is reworded.
- Sec-3: added to the C4 residuals.

---

# Round 5
Date: 2026-10-08

## Findings (single reviewer, three expert sections)
- **F-R5-1 [Major] design** (R1/R48). This is a regression from the Test-3 resolution. C2 was told not to reuse `ast-project.mjs`, so it would duplicate the shared walk and exclusion policy (symlink refusal, `__tests__`, `.spec.`).
- **F-R5-2 [Minor] prose** (R29, build-and-execute). "Statement-level" write detection would miss M9/M10's DELETE, which sits inside a CTE body. The self-test rows already pin the behaviour.
- **S-R5-1 [Minor] prose** (R29). The tenant_id rationale is wrong: an unset value reads as NULL and raises nothing. Under an asserted bypass, the policy's bypass arm makes tenant_id irrelevant.
- **S-R5-2 [Minor] prose** (R49). An opaque `${…}` target table (M13/M14) defaults to the key `id`. This is an undeclared C4 residual.
- **T-R5-1 [Minor] prose** (RT4/R29). The M7/M8 cap tests carry the same ambient-row residual as M9/M10, but it is undeclared.

Verified: every round-4 resolution except Test-3 is correct. The guard-test and wrapper-test red proofs can fail. The SC3 grep matches.

## Resolution (plan revision 6)
- F-R5-1: C2 walks files through `ast-project.mjs`, which gains an optional extension set (default unchanged) and a matching `.test`/`.spec` suffix set. Self-test rows are added for each extension, for `__tests__`, and for a symlink.
- F-R5-2: write detection is defined as statement position: the literal start, after `;`, or a CTE body start.
- S-R5-1, S-R5-2 and T-R5-1: reworded or declared as above.

---

# Round 6
Date: 2026-10-08

## Findings
- **RV6-1 [Minor] prose** (RT7/RT10-adjacent). The per-extension, `__tests__` and symlink self-test rows appear in C2's prose but not in its Self-test list. Resolved in revision 7: the rows are added to the list.

Verified:
- F-R5-1: `walkSourceFiles` / `collectSourceFiles` exist. No caller passes a second argument, so an optional extension set is backward-compatible.
- F-R5-2: M9 and M10 start with `WITH deleted AS (`.
- S-R5-1: holds for all three tables. Each has one never-superseded policy, `COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid`.
- S-R5-2 and T-R5-1: declared.

## Saturation call (round 6)
1. Six rounds have completed.
2. No Critical or Major is open, and none carries an Anti-Deferral disposition.
3. No finding targets the design. RV6-1 was labelled prose by the reviewer.
4. The only remaining Minor, RV6-1, is prose and has been fixed.

The plan exits review and proceeds to Phase 2. Nothing is carried forward. Open residuals are stated in the plan itself: the C2 declared bypasses; the C4 residuals (nested `picked` scope, a second unbounded write in one literal, `${…}` keys and table); SC1–SC3; and the accepted dev-DB ambient-row residuals for M1–M8.

---

# Round 6 addendum
Date: 2026-10-08

## Findings
- **Func-R6-1 / Test-R6-1 [Major, convergent] design** (R1/R3/RT7). The new extension set for `walkSourceFiles` / `collectSourceFiles` was not required to pass through their internal recursion and delegation (`ast-project.mjs` around lines 180 and 207). Nested `.mjs` files would then fall back to `.ts`/`.tsx`, and flat self-test fixtures would not catch it.

Verified: all round-5 resolutions hold against code. The `walkSourceFiles` / `collectSourceFiles` names and the symlink refusal exist. M9/M10 have the DELETE at the start of a CTE body. The RLS clause is identical on all three tables.

## Resolution (plan revision 7, applied during Phase 2)
This entry was appended by a review run left over from the session before the restart. The finding stands. The extension set is threaded through every internal call. The per-extension deny fixtures sit one directory below the fixture root.
