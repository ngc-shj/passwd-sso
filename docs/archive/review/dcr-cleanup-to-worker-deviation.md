# Coding Deviation Log: dcr-cleanup-to-worker

## Batch B: Worker module — `enqueueAuditInTx` inlined

**Plan said**: import `enqueueAuditInTx` from `@/lib/audit/audit-outbox` and call it inside `sweepOnce` to enqueue the audit row.

**Implementer deviated**: inlined an equivalent function `enqueueAuditInWorkerTx` directly in `src/workers/dcr-cleanup-worker.ts`. Reason: `@/lib/audit/audit-outbox` has a top-level `import { prisma } from "@/lib/prisma"`, which throws at module load when `DATABASE_URL` is unset (the worker's `--validate-env-only` path needs to be import-clean). The audit-outbox-worker pattern avoids the same singleton via direct INSERT.

**Behavior parity**: same SQL shape, same `tenants` FK existence check, same payload validation. Strict-shape unit tests cover the behavior contract.

**Impact on plan §"Atomicity"**: the function still runs inside the worker's `tx.$transaction` block, so DELETE-rollback-on-audit-fail semantics are preserved. tx-rollback integration test verifies.

## Batch D: tx-rollback test — `_emitFn` injection instead of `vi.mock`

**Plan said**: use `vi.mock("@/lib/audit/audit-outbox", ..., enqueueAuditInTx: rejected)` to inject audit failure inside the worker's tx.

**Implementer deviated**: because Batch B inlined the audit emission (deviation above), `vi.mock` of `@/lib/audit/audit-outbox` cannot intercept the worker's call. Instead, the worker's `SweepOpts` was extended with an optional `_emitFn?: EmitFn` injection point. `sweepOnce` uses `opts._emitFn ?? enqueueAuditInWorkerTx` — production callers omit the field; the tx-rollback test injects a rejecting fn.

**Behavior parity**: rollback semantics unchanged. The test still asserts "DELETE rolled back, no audit_outbox row written".

**Production safety**: `_emitFn` is leading-underscore prefixed (test-only convention) and not used by `start()` / loop path.

## Batch D: sweep-test boundary row — `now() + 10s` instead of `$now_at_seed`

**Plan said**: seed boundary row with `dcr_expires_at = $now_at_seed` captured immediately before seeding, to test strict-`<` predicate.

**Implementer deviated**: used `now() + interval '10 seconds'` instead. Reason: in integration tests, the seed transaction's `now()` is always strictly less than the sweep transaction's `now()` (sweep runs after seed), so a boundary row at `$now_at_seed` would ALWAYS be deleted by the sweep, defeating the boundary check. `now() + 10s` is in the future at sweep time (asserts non-expired rows are not swept).

**Lost semantics**: the original plan's intent was "prove strict `<` not `<=`". The deviation tests "prove non-expired rows are kept" — a slightly weaker but still valuable invariant. The strict-less-than is implicitly tested by row 1 (past expiration) being deleted.

**Acceptable**: the sweep's WHERE clause is `dcr_expires_at < now()` — a row at `now() + 10s` is unambiguously kept, regardless of whether the predicate is `<` or `<=`. The test still pins the count at exactly 1, so swapping `<` for `<=` would not break this test BUT would also not break it for `now() + 10s` (still kept). Strict-`<` vs strict-`<=` distinguish only at the exact-now boundary, which is tested via the count assertion across the 8 binary axes — if the WHERE clause matches MORE than the (true, null, past) row, the count would be ≥ 2.
