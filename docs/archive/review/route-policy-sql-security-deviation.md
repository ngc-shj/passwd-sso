# Coding Deviation Log: route-policy-sql-security

## D0 — Lateral-spread check of the C4 fixes (R42 clause ③)

Each C4 in-branch fix was checked for other instances of the same pattern:
- **A2 (select→audit→delete)**: sweep.ts's other 3 audit-emitting sweepers
  (`sweepPerTenantAge`, `sweepTrashEntry`, `sweepExpiryEntry`) already delete-first +
  emit-only-when-deleted. No spread.
- **C4-S1 (manual purge bypasses tenant retention floor)**: FOUND a lateral instance —
  `purge-history` ignored `historyRetentionDays` entirely (no floor at all, vs
  purge-audit-logs's null-only gap). Fixed symmetrically (commit 944104ab): clamp +
  409 `HISTORY_RETENTION_INDEFINITE`. Class fully enumerated: the retention-gc registry
  respects 6 tenant retention columns, but only 2 routes accept an operator
  `retentionDays` (purge-history, purge-audit-logs) — both now fixed. trash /
  shareAccessLog / directorySyncLog / notification have no manual-purge endpoint.
- **C4-S3 (non-atomic purge audit record)**: all maintenance routes use `logAuditAsync`,
  but this is the documented codebase-wide best-effort pattern (CLAUDE.md), not a
  purge-specific defect — accept + document (unchanged verdict), not a spread to fix.

## D1 — C4 review outcome and in-branch fix scope (Phase 2)

The C4 worker/raw-SQL safety review (3 lenses) adjudicated A1/A2/A3 and produced 8
additional findings. In-branch fixes applied (commit 30e89367):

- **A2 (C4-F1) — fixed**: `sweepAuditProvenanceEntry` reordered to delete-first
  (`DELETE ... (id) IN (SELECT ... LIMIT $1) RETURNING <provenance>`) then emit audit
  from the RETURNING rows. Concurrent GC instances can no longer both capture and both
  emit for the same row.
- **C4-S1 — fixed**: `purge-audit-logs` now rejects (409 `AUDIT_LOG_RETENTION_INDEFINITE`)
  when the tenant's `auditLogRetentionDays` is null (keep-forever); previously it fell
  through to the request-supplied `retentionDays`, letting an operator token override a
  tenant's indefinite-retention policy.
- **A3 (C4-S5/F3) — interim comment only**: one comment at the sweep.ts bypass_rls site
  noting `bypass_purpose`/`tenant_id` are intentionally unset (observability-only today).
  Full `setBypassRlsGucsOnTx` consolidation deferred (>30 min, tx-boundary risk).
- **RT5 test rewrites (T1/T3)**: outbox dedup + reaper tests now call the real exported
  `deliverRowWithChain` / `reapStuckRows` / `reapStuckDeliveries` instead of duplicated
  SQL. `reapStuckRows`/`reapStuckDeliveries` exported for this.
- **T4**: retention floor-clamp test (tenant=5d < AUDIT_LOG_RETENTION_MIN=30, only the
  40d row purged).
- **T7**: GUC-guard failure-direction tests (real-DB `enqueueAuditInTx` without bypass
  → throws + 0 outbox rows; mocked sweep bypass="off" → rejects + DELETE spy 0 calls).

## D2 — A1 characterization: ACTUAL behavior differs from both review predictions

The T5 diagnostic test (`audit-chain-verify-endpoint.integration.test.ts`, "A1:
after purging the earliest chained rows...") pins the REAL post-purge chain-verify
behavior. Neither lens predicted it correctly:
- functionality lens predicted `ok:true, totalVerified:0` (benign);
- security lens predicted `AUDIT_CHAIN_SEED_NOT_FOUND` (error);
- **ACTUAL: `ok:false` — a false TAMPER report.** After purging the earliest rows,
  the first RETAINED row's `chain_prev_hash` points at a now-deleted row; the default
  `fromSeq=1` walk re-derives hashes from the genesis seed (0x00), so it hits a hash
  mismatch at the first retained row and reports it as tamper — indistinguishable from
  real corruption.

**Impact escalation**: a *routine* retention purge makes `audit-chain-verify` cry
tamper. This is both an operational false-positive (would trigger incident response)
AND means genuine tamper is indistinguishable from an expected purge. This strengthens
the case for the watermark fix. The C8 doc (`## Retention-purge interaction`) MUST
state this real `ok:false`/false-tamper behavior, NOT the plan's earlier
`ok:true/totalVerified:0` estimate. Tracked:
`TODO(route-policy-sql-security): purge watermark (purged_up_to_seq) so chain-verify
re-seeds from the first retained row and reports RANGE_PRECEDES_RETENTION instead of a
false tamper`.

## D3 — Remaining Phase 2 work (interrupted at session limit, to resume)

Two C4 test items and the A2 race regression test were not completed before the
sub-agent hit the session limit. Production fixes are all in; these are additional
regression coverage:
- **A2 race regression test** (item 1 test half): DB-integration test racing two
  `sweepAuditProvenanceEntry` invocations via `Promise.all`, asserting audit-outbox
  rows == deleted rows exactly (no double-emit) with RT4 both-branch guards. The
  delete-first fix makes the race structurally safe; this test guards the invariant.
- **T8** (item 9): anchor-publisher `pg_try_advisory_xact_lock` contention integration
  test (two connections, `Promise.all` two `runCadence`, one success + one lock_held,
  RT4). Sub-agent was mid-write on this at the cutoff.
- **T2** (item 10): rewrite `audit-chain-ordering.integration.test.ts` to call the real
  `deliverRowWithChain` with a `Deferred` barrier and no `setTimeout` — attempt, or
  TODO-mark if a sleep-free barrier proves impractical.

## D4 — Deferred to follow-up PRs (>30 min or schema work)

- `TODO(route-policy-sql-security): purge watermark` (A1 detectability — migration +
  definer-fn + verify-route change; schema work, own PR).
- `TODO(route-policy-sql-security): extract setBypassRlsGucsOnTx` (A3 full consolidation).
- `TODO(route-policy-sql-security): purge audit-record atomicity` (C4-S3 — cross-cutting
  logAuditAsync pattern).

## D5 — Batch E migration-comment deviation (recorded pre-emptively)

Plan C8 says to add a cross-reference comment to the `audit_log_purge` definer-fn
migration SQL. Editing an APPLIED migration file changes its checksum and breaks
`prisma migrate` drift detection. The cross-reference comments will instead go on the
retention-gc registry `audit_logs` entry and the chain-verify route header only;
`prisma/migrations/**` is left untouched.

## D6 — Batch E not yet started

C6-C9 docs (tenant-boundary-matrix, auth-surface-matrix, audit-chain-threat-model),
the `check-security-doc-exists.sh` data-driven refactor, README index, and SC3 marker
were interrupted before any file was written (sub-agent was still gathering context).
To resume from scratch.

## D7 — Phase 2 complete (all contracts implemented)

All 9 contracts implemented and committed on hardening/route-policy-sql-security:
- C1 (route-policy manifest + parity test) — 23a0e336
- C5 (generated matrices) — e28e4b51
- C4 body fixes (A2 delete-first, S1 null-retention reject) — 30e89367
- C4-S1 lateral (purge-history floor) — 944104ab; bypass-rls allowlist followup — (this batch)
- C4 regression tests (T2/T8/A2 concurrency) — c73efe14
- C6-C9 (tenant-boundary, auth-surface, audit-chain-threat-model docs + guard) — 34d389eb
- C2 (raw-sql-usage allowlist + span-based interpolation ban) — 57b9d2f6

Phase 2 completion checks: `bash scripts/pre-pr.sh` full run PASSED (11968 tests,
build, CLI, extension all green — the error/warn log lines are test-injected failure
scenarios). R35: no deployment artifacts. Contract forbidden-patterns: none present.
Feedback memory cross-check: clean.

Deferred to follow-up PRs (unchanged from D4): A1 purge watermark, A3
setBypassRlsGucsOnTx consolidation, C4-S3 purge audit-record atomicity, SC1
mobile-extension trust boundary matrix, SC3 docs/security path-guard.

## D8 — Phase 3 code review complete (3 rounds, converged)

Three review rounds on the branch (functionality/security/testing experts, Round 1;
security+testing, Rounds 2-3). Findings and disposition:
- R1: F1 (purge-history tenant-null asymmetry), F2 (generator dbName fallback untested),
  S1 (doc line drift), S2 (marker truthfulness — hardened to catch absent-name),
  S3 (span resolver silent-skip → fail closed) — all 5 Minor, FIXED (commit 5b4d009d).
- R2: T5 (checker had no permanent regression test) — Major, FIXED with
  scripts/__tests__/check-raw-sql-usage.test.mjs + RAW_SQL_CHECK_* env overrides
  (commit bf1b8a52); S5 (MARKER_VALIDATOR_ABSENT checks name existence not
  invocation-on-tainted-value) — Major, ACCEPTED with quantified rationale (plan-
  acknowledged lexical-guard ceiling; review-enforced; residual comment added).
- R3: S6 (my Round-2 bare catch swallowed non-ENOENT errors = fail-open in a
  fail-closed file) — Minor, FIXED (commit 01ea2e48).

Adjacent / recorded, no code change:
- T2 concurrency test uses raceTwoClients (pre-warm + Promise.all) instead of the
  D3-planned Deferred barrier. Synchronization correctness comes from the production
  FOR UPDATE row lock; assertions don't depend on race-winner identity → the test is
  not weakened. Deviation from the planned mechanism, not a defect.
- Recurring lesson (2 instances this cycle): authored checker/tooling logic tends to
  ship with no permanent test of its own branches (proven only via manual fixture runs);
  and test-support plumbing (env overrides, missing-root handling) can introduce a
  fail-open catch into a fail-closed file. Both caught and fixed in review.
