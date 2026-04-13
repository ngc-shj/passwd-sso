# Code Review: audit-outbox-integration-tests
Date: 2026-04-13
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 — Major: `vitest.integration.config.ts` missing `poolOptions.forks.singleFork`
- **Status**: Skipped — vitest 4.x `InlineConfig` type does not include `poolOptions.forks.singleFork`. Adding it causes `npx next build` TypeScript failure. `pool: "forks"` + `maxWorkers: 1` achieves serial execution (one fork at a time). The design plan's P4-T1 prerequisite is satisfied by the `maxWorkers: 1` setting.

### F2 — Major: Worker-role privilege tests not updated for Phase 4 grants
- **Status**: Resolved in commit `review(1)`
- Both `audit-outbox-worker-role.integration.test.ts` and `audit-outbox-worker-role-phase3.integration.test.ts` now assert the full migration-applied grant set including `audit_chain_anchors`, FK ref tables, and correct `audit_logs` privileges.

### F3 — Major: `audit-outbox-skip-locked.integration.test.ts` used superuser role
- **Status**: Resolved in commit `review(1)`
- Changed both worker clients to use `createPrismaForRole("worker")`.

### F4 — Major: `audit-outbox-reentrant-guard.integration.test.ts` does not invoke worker code
- **Status**: Accepted — The test verifies DB-level invariants (bypass actions allow NULL outboxId, non-bypass actions are rejected, OUTBOX_BYPASS_AUDIT_ACTIONS set membership). The worker code path for R13 is covered by the existing mocked unit test `audit-fifo-flusher.test.ts`. Full worker invocation in an integration test would require running the actual worker process, which is better suited for E2E tests.

### F5 — Major: `audit-delivery-stuck-reaper.integration.test.ts` missing dead-letter assertion
- **Status**: Resolved in commit `review(1)`
- Added `AUDIT_DELIVERY_DEAD_LETTER` audit_logs assertion to the max_attempts test case.

### F6 — Minor: `audit-outbox-null-invariant.integration.test.ts` does not iterate full bypass set
- **Status**: Accepted — The test verifies the DB CHECK constraint behavior (SYSTEM actor allows NULL outboxId). Iterating the full set would test the same constraint N times without additional coverage.

### F7 — Minor: CI job missing explicit `APP_DATABASE_URL`/`OUTBOX_WORKER_DATABASE_URL`
- **Status**: Accepted — The regex fallback in helpers.ts works correctly for standard PostgreSQL URLs. Explicit env vars can be added if URL format changes.

### F8 — Minor: `audit-chain-ordering.integration.test.ts` uses `setTimeout(50ms)`
- **Status**: Accepted — The 50ms delay ensures both transactions have started their INSERT before reaching the FOR UPDATE barrier. The actual concurrency ordering is enforced by the Deferred barrier pattern at the FOR UPDATE point. CI runners with higher latency would still work correctly because the barrier synchronizes the critical section.

## Security Findings

### S1 — Major: Worker-role privilege tests mismatch migration grants
- **Status**: Resolved (merged with F2) in commit `review(1)`

### S2 — Minor: `audit_logs` expected `["INSERT"]` but actually `["INSERT", "SELECT"]`
- **Status**: Resolved (merged with F2) in commit `review(1)`

### S3 — Minor: Worker `bypass_rls` GUC concern
- **Status**: Accepted — The worker is designed to operate with bypass_rls (same as passwd_app). This is documented in the plan (N4): "The worker's DB role MUST also have RLS bypass disabled at the role level (NOBYPASSRLS); access is only via the GUC."

### S4 — Minor: CI plain-text credentials
- **Status**: Accepted — CI-only ephemeral credentials for local PostgreSQL instance, consistent with existing rls-smoke and e2e jobs.

### S5 — Minor: `$executeRawUnsafe("SELECT 1")`
- **Status**: Resolved in commit `review(1)`

## Testing Findings

### T1 — Critical: 8 mocked test files missing
- **Status**: Out of scope — User explicitly requested "integration tests + CI job". Mocked tests (metrics endpoint auth, SSRF, deliverer HTTP, readiness probe) are separate scope items. Several already exist from prior Phase implementations.

### T2/T3 — Critical: Privilege assertion mismatches
- **Status**: Resolved (merged with F2/S1) in commit `review(1)`

### T4 — Critical: `audit-chain-disabled` CHECK constraint violation
- **Status**: Resolved in commit `review(1)` — Added outbox_id to satisfy the `(outbox_id IS NOT NULL OR actor_type = 'SYSTEM')` constraint.

### T5 — Major: CI grant non-alignment
- **Status**: Resolved in commit `review(1)` — CI grants now match migration-applied privileges exactly.

### T6 — Major: singleFork missing
- **Status**: Skipped (merged with F1) — vitest 4.x InlineConfig type does not support `poolOptions.forks.singleFork`.

### T7 — Major: skip-locked uses superuser
- **Status**: Resolved (merged with F3) in commit `review(1)`

### T8 — Major: delivery dead-letter meta-event missing
- **Status**: Resolved (merged with F5) in commit `review(1)`

### T9 — Major: reentrant guard no worker invocation
- **Status**: Accepted (merged with F4) — DB-level invariant test; worker code path covered by mocked unit test.

### T10 — Major: metrics integration test no endpoint call
- **Status**: Accepted — Integration test verifies the SQL aggregation query correctness against real data. The HTTP handler behavior (auth, rate limit, logAudit call) is covered by the mocked endpoint test.

### T11 — Minor: null-invariant test naming
- **Status**: Accepted — Test name accurately reflects the DB CHECK constraint behavior being tested.

### T12 — Minor: state-machine test uses manual SQL
- **Status**: Accepted — Testing state transitions directly via SQL is appropriate for verifying DB-level behavior independently of worker implementation.

### T13 — Minor: chain-disabled describe name
- **Status**: Accepted — Test name is clear about what is being verified.

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status
All Critical and Major findings resolved or accepted with justification.
