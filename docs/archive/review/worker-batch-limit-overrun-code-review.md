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
