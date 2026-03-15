# Code Review: optimize-db-indexes
Date: 2026-03-16T02:30:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 — Minor
**File:** prisma/schema.prisma, AuditLog model (lines 827–829)
**Problem:** AuditLog indexes use `createdAt(sort: Desc)` but download endpoints use `ORDER BY createdAt ASC`. PostgreSQL can scan B-tree in reverse, so no performance or correctness issue, but the direction annotation could be misleading.
**Recommended fix:** No code change needed. Consider a schema comment.

### F2 — Minor
**File:** prisma/schema.prisma, AuditLog model (line 827); src/app/api/audit-logs/route.ts (lines 34–46)
**Problem:** Personal audit log uses `OR` clause (`userId=X OR metadata.ownerId=X`). The new index `[userId, scope, createdAt DESC]` only covers the first branch. This is a pre-existing gap, not a regression.
**Impact:** EMERGENCY_VAULT_ACCESS is rare, practical impact low.
**Recommended fix:** No change for this PR. Potential future optimization.

### F3 — Minor
**File:** prisma/schema.prisma, TeamPasswordEntry model (line 567)
**Problem:** `TeamPasswordEntry` archived query uses `WHERE teamId AND isArchived=true AND deletedAt=null`. The new index `[teamId, deletedAt]` does not include `isArchived`. Not a regression — old index also lacked it.
**Recommended fix:** Could add `isArchived` for `[teamId, deletedAt, isArchived]` if archived cross-team queries are common. Out of scope for this PR.

### Verified No Issues
- Session `[userId, expires]`: all read paths covered
- PasswordEntry `[userId, deletedAt, isArchived]`: all query shapes covered
- PasswordShare removal of `[shareType]`: confirmed never used standalone
- EmergencyAccessGrant removal of `[status]`: confirmed never used standalone
- AuditLog `[tenantId, scope, createdAt DESC]`: `IN` list on scope uses multiple range scans, correct

## Security Findings

No findings. Index-only changes do not affect authentication, authorization, encryption, or data access control.

## Testing Findings

No findings. Existing test suite (416 files, 4551 tests) is sufficient for behavior-transparent index changes. CI/CD pipeline covers Prisma schema changes automatically.

## Adjacent Findings

None.

## Resolution Status

### F1 — Minor — AuditLog DESC annotation
- Action: Skipped — PostgreSQL handles bidirectional B-tree scans natively. No correctness or performance issue.

### F2 — Minor — Personal audit log OR clause
- Action: Skipped — Pre-existing gap, out of scope for this PR. EMERGENCY_VAULT_ACCESS is rare.

### F3 — Minor — TeamPasswordEntry isArchived
- Action: Skipped — Pre-existing gap, out of scope for this PR. Not a regression.
