# Coding Deviation Log: retention-gc-worker

## D1 — Prisma AuditAction enum value + dedicated migration (C6)
The plan's C6 said "add AUDIT_ACTION.RETENTION_GC_SWEEP" (TS const + groups + i18n). It did not call out that `AuditAction` is a **Prisma-generated enum** (`from "@prisma/client"`), so the value also needs to exist in the `AuditAction` enum in schema.prisma AND in the DB enum type. The production build (not vitest) caught this. Added the enum value to schema.prisma and a **separate** migration `20260617235900_add_retention_gc_sweep_audit_action` (runs before the role-grant migration) — Postgres forbids using a newly-added enum value in the same transaction that adds it (R24 add-then-use hazard avoided by separation).

## D2 — C7 grant list corrected: dropped users/teams/service_accounts (R14)
C7 said to grant `SELECT` on `users`/`teams`/`service_accounts` "mirroring the outbox-worker role". The Phase-2 self-R-check (R14) found this was over-privilege: the outbox-worker delivers to `audit_logs` and FK-checks those tables, but the retention-gc worker only **enqueues** to `audit_outbox` (whose sole FK is `tenants`) and reads `tenants` for the emit EXISTS check — it never reads users/teams/service_accounts. Removed the 3 grants from the migration; revoked them from the dev DB to match. Verified the worker still functions (role integration test green). Plan C7 updated to record the correction.

## D3 — Per-entry isolation: fault-injection UNIT test, live-DB wiring INTEGRATION test
C4's acceptance implied an integration test forcing one entry to fail. A real-DB integration test cannot deterministically make exactly one registry entry throw (every entry is valid against the real schema). Genuine per-entry isolation (INV-C4b) is proven in a new UNIT test `src/workers/retention-gc-worker/__tests__/sweep-isolation.test.ts` that mocks `workerPrisma.$transaction` to reject for one table and resolve for others, asserting the failing table → -1 and siblings → their counts (RT7: goes red if the per-entry try/catch is removed). The integration test was relabeled to its honest scope: a live-DB end-to-end wiring check (all entries run with no -1). The T13 heartbeat-failure idempotency test remains in integration (deterministic via the `_emitFn` override).

## D4 — predicate.ts uses switch, not if-chain (TS narrowing)
The build's TypeScript pass rejected the if-return chain in `renderPredicate` because the union's first member carries `op: "IS NULL" | "IS NOT NULL"` (two literals in one member), so sequential `===` checks did not narrow to the `=` member (which has `value`). Switched to `switch (clause.op)` which narrows correctly. Behaviorally identical; predicate unit test unchanged and green.

## D5 — RLS_FREE_EXPIRY_TABLES constant extracted (user request)
Per user request ("定数とか考えてください"), the boot validator's hardcoded `new Set(["verification_tokens"])` was extracted to an exported `RLS_FREE_EXPIRY_TABLES` constant co-located with the registry in registry.ts, so the "which tables may omit globalDelete" fact lives in one place next to the registry rows it governs (drift prevention). The `audit_log_purge` function name was deliberately NOT extracted to a constant — it lives inside tagged-template `$queryRaw` literals where a constant cannot be interpolated without switching to the less-safe `$queryRawUnsafe`; the registry's typed `fn: "audit_log_purge"` field already documents it.

## D6 — .env.example regenerated
`npm run generate:env-example` regenerated `.env.example` from the schema+sidecar after the DCR_CLEANUP_* → RETENTION_GC_* env rename (C6/C9); `npm run check:env-docs` passes.
