# Code Review: audit-outbox-phase2
Date: 2026-04-13T00:20:00Z
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 Minor: reapStuckRows RETURNING attempt_count naming
- File: src/workers/audit-outbox-worker.ts:354
- RETURNING value is post-increment; naming could be clearer
- Resolution: Skip — no behavioral impact

### F2 Minor: purgeRetention MIN(tenant_id::text) picks arbitrary tenant
- File: src/workers/audit-outbox-worker.ts:401
- Cross-tenant purge summary logged to lexicographic-minimum tenant
- Resolution: Skip — documented in deviation log, infrastructure event

### F3 Minor: logAuditBatch N+1 tenantId resolution
- File: src/lib/audit.ts:273
- Old batch resolution was 1-2 queries; new is N queries per entry
- Resolution: Skip — logAuditBatch is deprecated, callers generally provide tenantId

## Security Findings

### S4 Major: operatorId cross-tenant — any tenant ADMIN sees global metrics
- File: src/app/api/maintenance/audit-outbox-metrics/route.ts:56-65
- Any tenant ADMIN with ADMIN_API_TOKEN can view cross-tenant aggregates
- Resolution: **Accepted** — ADMIN_API_TOKEN is the infrastructure-level auth gate, not tenant-level. Only infra operators possess this token. Matches existing patterns (purge-history, purge-audit-logs).
  - **Anti-Deferral check**: acceptable risk
  - **Justification**:
    - Worst case: tenant admin sees aggregate counts (pending/failed/processing) — no PII, no entry content
    - Likelihood: low — ADMIN_API_TOKEN is 256-bit hex, not distributed to tenant admins
    - Cost to fix: ~2h (new OPERATOR role + migration + auth refactor) with regression risk

### S1 Minor: Worker $queryRawUnsafe consistency
- Resolution: Skip — no external input, worker-internal constants only

### S3 Minor: Global rate limit keys
- Resolution: Skip — matches existing purge-history/purge-audit-logs patterns

### S5 Minor: writeDirectAuditLog action typed as string
- Resolution: Skip — all call sites use AUDIT_ACTION.* constants

## Testing Findings

### T1 Major: txCallCount comments inverted in reaper test — **Fixed**
- Action: Aligned comments with actual execution order (writeDirectAuditLog before purgeRetention)
- Modified file: src/workers/audit-outbox-worker.test.ts

### T2 Major: Error-path test purgeRetention mock shape undefined — **Fixed**
- Action: Added explicit `{purged: BigInt(0), sample_tenant_id: null}` mock for tx 3
- Modified file: src/workers/audit-outbox-worker.test.ts

### T5 Major: No test for logAuditAsync rejection handling — **Fixed**
- Action: Added "propagates enqueueAudit rejection without throwing" test
- Modified file: src/__tests__/audit-fifo-flusher.test.ts

### T3 Minor: Hardcoded toHaveLength(5) — **Fixed**
- Action: Changed to `toBeGreaterThanOrEqual(5)`
- Modified file: src/__tests__/audit-bypass-coverage.test.ts

### T6 Minor: suppressOnlyAction runtime set subtraction — **Fixed**
- Action: Pinned to `AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW`
- Modified file: src/workers/audit-outbox-worker.test.ts

### T4 Minor: i18n file reads at describe-scope
- Resolution: Skip — existing pattern (audit-log-keys.test.ts uses same approach)

## Adjacent Findings
None

## Quality Warnings
None

## Recurring Issue Check
### Functionality expert
- R1: Checked — no issue (shared utilities reused: verifyAdminToken, createRateLimiter, withBypassRls)
- R2: Checked — no issue (constants from AUDIT_OUTBOX, not hardcoded)
- R3: Checked — no issue
- R4: N/A — no new mutation sites
- R5: N/A — no multi-step DB ops without tx
- R6: N/A — purge is intentional
- R7: N/A — no E2E tests
- R8: Checked — no issue (GROUP_LABEL_MAP updated)
- R9: Checked — no issue (void dispatchWebhookForRow is outside tx in processBatch)
- R10: Checked — no issue
- R11: Checked — MAINTENANCE excluded from webhook groups
- R12: Checked — all 5 actions in groups, i18n, UI, tests ✓
- R13: Checked — WEBHOOK_DISPATCH_SUPPRESS prevents re-entrant loop
- R14: N/A — no new DB roles in Phase 2
- R15: Checked — migration uses no hardcoded env values

### Security expert
- RS1: Checked — verifyAdminToken uses SHA-256 + timingSafeEqual
- RS2: Checked — both new routes have rate limiters
- RS3: Checked — Zod validation on all inputs

### Testing expert
- RT1: Checked — mock shapes match actual responses (Fixed T2)
- RT2: N/A
- RT3: Checked — tests import from shared constants

## Resolution Status
All Critical/Major findings resolved or accepted with justification.
Tests: 6984/6984 passed. Build: success.
