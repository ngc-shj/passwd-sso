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

---
