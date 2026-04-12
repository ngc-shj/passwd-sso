# Coding Deviation Log: durable-audit-outbox

Created: 2026-04-12

## Deviations from Plan

### DEV-1: withBypassRls signature — union type instead of overload
- **Plan description**: Refactor `withBypassRls` to `fn: (tx) => Promise<T>`
- **Actual implementation**: Used union type `fn: ((tx: Prisma.TransactionClient) => Promise<T>) | (() => Promise<T>)` for backward compatibility
- **Reason**: TypeScript does not allow `() => Promise<T>` to be assigned to `(tx: ...) => Promise<T>`. Union type is the cleanest backward-compatible approach without touching 158 callers.
- **Impact scope**: `src/lib/tenant-rls.ts` — both `withBypassRls` and `withTenantRls`

### DEV-2: poolOptions removed from vitest.integration.config.ts
- **Plan description**: `pool: 'forks'` + `poolOptions: { forks: { singleFork: true } }`
- **Actual implementation**: Only `pool: "forks"`, no `poolOptions`
- **Reason**: `next build` type-checks all `.ts` files including vitest configs. `poolOptions` is vitest-internal and not in the generic `InlineConfig` type, causing a build failure. Serial execution is still achieved by `pool: "forks"` default behavior.
- **Impact scope**: `vitest.integration.config.ts` — integration tests run sequentially by default with forks pool

### DEV-3: AUDIT_OUTBOX constants defined by Batch C, refined by Batch B
- **Plan description**: Constants defined once in `src/lib/constants/audit.ts`
- **Actual implementation**: Batch C (worker) added the constants first; Batch B (core library) refined values. Final state is correct and unified.
- **Reason**: Parallel sub-agent execution. Both batches needed the constants. No conflict in final state.
- **Impact scope**: `src/lib/constants/audit.ts` — single authoritative definition

### DEV-4: AUTH_LOGIN/AUTH_LOGOUT migration deferred (as planned)
- **Plan description**: Defer these two call sites (NextAuth event callbacks)
- **Actual implementation**: Not touched. logAudit void shim handles them via FIFO flusher.
- **Reason**: NextAuth `events.signIn`/`events.signOut` callbacks have no transaction scope available. Would require significant auth config refactoring.
- **Impact scope**: None — these flow through the existing FIFO path

### DEV-5: Worker userId=null handling — skip instead of insert
- **Plan description**: Phase 2 migration makes audit_logs.userId nullable with CHECK constraint
- **Actual implementation**: Phase 1 worker skips rows with null userId (logs warning). The CHECK constraint `audit_logs_outbox_id_actor_type_check` was added in the Phase 1 migration, but `audit_logs.userId` is NOT yet nullable (Phase 2 change).
- **Reason**: Making userId nullable is a schema change that affects many existing queries and is deferred to Phase 2. Phase 1 worker correctly skips these edge cases.
- **Impact scope**: Worker — rare edge case (no SYSTEM actor events in Phase 1)

### DEV-6: Security-critical call sites use separate transactions (not same-tx atomic)
- **Plan description**: Plan F1 + checklist states these sites achieve "business write ⇔ audit row" atomicity via `logAuditInTx`
- **Actual implementation**: SHARE_CREATE, SHARE_REVOKE, VAULT_UNLOCK_FAILED, VAULT_LOCKOUT_TRIGGERED all call `logAuditInTx` in a separate `withBypassRls` transaction (tx2) AFTER the business mutation's transaction (tx1) has committed. If tx2 fails, the business write exists without an outbox row.
- **Reason**: The business mutations use tenant-scoped or AUTH_FLOW-purpose RLS modes (`withUserTenantRls`, `withBypassRls(..., AUTH_FLOW)`) that are incompatible with `BYPASS_PURPOSE.AUDIT_WRITE` in a single transaction. Merging them requires refactoring the RLS context model, which is out of scope for Phase 1.
- **Impact scope**: The actual improvement over pre-outbox behavior is: synchronous awaited outbox enqueue (not fire-and-forget), with immediate error surfacing. True same-tx atomicity requires a future refactoring of `withBypassRls` to support multiple purposes in one transaction.

### DEV-7: webhook-dispatcher.ts backoff migration reverted
- **Plan description**: Plan R1 specifies migrating webhook-dispatcher RETRY_DELAYS to use `computeBackoffMs` from `backoff.ts`
- **Actual implementation**: Reverted to original hardcoded `[1_000, 5_000, 25_000]` array
- **Reason**: `computeBackoffMs` with `baseMs=1000, capMs=25000` produces `[1000, 2000, 4000]` — different values than the original. The webhook retry curve is intentionally steeper and not a standard exponential backoff.
- **Impact scope**: Two backoff implementations coexist. The shared helper is used only by the outbox worker.

---
