# Coding Deviation Log: perf-audit-codebase
Created: 2026-03-16T14:00:00+09:00

## Deviations from Plan

### D-1: Item 2 (logAudit tenantId resolution) — skipped as standalone
- **Plan description**: Add tenantId to logAudit call sites where it's already known
- **Actual implementation**: Not implemented as a separate step. The tenantId resolution in logAuditBatch (Item 3) resolves tenantId once per batch instead of per-entry, which addresses the core issue
- **Reason**: For personal bulk routes, tenantId is not directly available from session. For team bulk routes, the teamId→tenantId lookup is a single PK query. The batch approach (1 lookup per batch vs N lookups per N entries) is the real win
- **Impact scope**: None — Item 3 subsumes the benefit

### D-2: Item 20 (withBypassRls short-circuit) — removed from plan
- **Plan description**: Skip nested withBypassRls transaction when already in bypass context
- **Actual implementation**: Removed during plan review
- **Reason**: Low ROI, high risk of RLS context confusion. fire-and-forget logAudit runs in a separate async chain where the parent's ALS context is not inherited
- **Impact scope**: None

### D-3: Item 14 (favorite route) — 3→2 queries instead of 3→1
- **Plan description**: Collapse 3 queries into 1 using include + deleteMany
- **Actual implementation**: Included favorites in entry query (eliminating 1 findUnique), used deleteMany for delete path. Still 2 queries total
- **Reason**: The create/upsert path still requires a separate write query. Net improvement is 3→2 queries
- **Impact scope**: Team favorite PUT/DELETE handlers
