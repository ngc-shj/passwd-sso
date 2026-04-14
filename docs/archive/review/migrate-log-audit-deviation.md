# Coding Deviation Log: migrate-log-audit
Created: 2026-04-14

## Deviations from Plan

### D1: webhook-dispatcher.ts TENANT scope userId also changed to NIL_UUID
- **Plan description**: MF6 specified fixing only TEAM scope (L231) `userId: "system"` → `NIL_UUID`. TENANT scope (L302) was to keep `userId: "system"` since `tenantId` is provided.
- **Actual implementation**: Both TEAM and TENANT scope changed to `userId: NIL_UUID` for consistency.
- **Reason**: User decision — "揃えた方が良いのであれば揃えましょう" (if it's better to align them, let's do it).
- **Impact scope**: Both webhook delivery failure audit entries now use `NIL_UUID` instead of `"system"` for `userId`. TENANT scope still works via the normal outbox path (UUID passes the `UUID_RE` check).

### D2: src/lib/mcp/tools.ts `auditDelegationAccess` made async
- **Plan description**: Plan only specified mechanical `logAudit` → `await logAuditAsync` replacement.
- **Actual implementation**: The helper function `auditDelegationAccess` was not `async`, so adding `await` required making it `async` and adding `await` at both call sites (`toolListCredentials`, `toolSearchCredentials`).
- **Reason**: TypeScript requires `await` only inside `async` functions. The function signature had to change to accommodate the migration.
- **Impact scope**: `auditDelegationAccess` and its 2 callers. No behavioral change beyond making the audit call awaitable.

### D3: Bulk test assertions rewritten (not just renamed)
- **Plan description**: Plan Step 10d said "grep for logAuditBatch in all test files — update imports and calls".
- **Actual implementation**: Bulk operation tests (8 files) required significant assertion restructuring because `logAuditBatch(entries)` (single call with array) became `for (const entry of entries) { await logAuditAsync(entry); }` (multiple individual calls). The `mockLogAuditBatch` variable was removed entirely and assertions were rewritten to check individual `mockLogAudit` calls.
- **Reason**: The test assertion pattern fundamentally changed — a single batch call became multiple per-entry calls.
- **Impact scope**: 8 bulk operation test files (personal + team).

---
