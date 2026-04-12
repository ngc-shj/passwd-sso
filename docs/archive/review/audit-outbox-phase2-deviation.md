# Coding Deviation Log: audit-outbox-phase2
Created: 2026-04-12T23:35:00Z

## Deviations from Plan

### D1: Metrics endpoint uses operatorId query parameter
- **Plan description**: GET /api/maintenance/audit-outbox-metrics with Bearer token auth
- **Actual implementation**: Added `operatorId` as required query parameter for tenant membership check and audit logging (same pattern as purge endpoints)
- **Reason**: Without operatorId, the system-level ADMIN_API_TOKEN auth has no userId for audit log entries and no way to resolve tenantId. Query param follows existing admin endpoint patterns.
- **Impact scope**: Metrics endpoint API contract

### D2: Worker reaper retention purge uses NIL_UUID tenant for system-level events
- **Plan description**: Design doc mentions "pick any tenant" for retention purge audit log
- **Actual implementation**: Uses NIL_UUID as tenantId for `AUDIT_OUTBOX_RETENTION_PURGED` events since it's a cross-tenant infrastructure event
- **Reason**: Picking an arbitrary tenant would associate an infrastructure event with a specific tenant incorrectly. NIL_UUID matches the SYSTEM actor convention.
- **Impact scope**: audit_logs.tenant_id for retention purge events

### D3: resolveTenantIds batch helper replaced with single resolveTenantId
- **Plan description**: FIFO flusher used batch `resolveTenantIds` (N+1 prevention for batches)
- **Actual implementation**: `logAuditAsync` uses single `resolveTenantId` per entry since there's no batching (direct enqueue)
- **Reason**: With FIFO removal, there's no batch to optimize. Each `logAuditAsync` call resolves one entry directly. The N+1 concern doesn't apply to single entries.
- **Impact scope**: src/lib/audit.ts internal implementation

### D4: Purge endpoint DELETE uses dynamic WHERE clause construction
- **Plan description**: Simple DELETE of FAILED rows
- **Actual implementation**: WHERE clause built dynamically from optional `tenantId` and `olderThanDays` filters using parameterized queries
- **Reason**: Matches the design doc spec for operator-driven purges with filtering capabilities. Uses parameterized queries (not string interpolation) to prevent SQL injection.
- **Impact scope**: src/app/api/maintenance/audit-outbox-purge-failed/route.ts

---
