# Coding Deviation Log: route-policy-sql-security

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
