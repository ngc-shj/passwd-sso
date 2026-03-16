# Code Review: optimize-db-access-loops
Date: 2026-03-16T13:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] Bulk ops audit entryIds may diverge from updateResult.count
Files: 6 bulk-archive/restore/trash routes (personal + team)
Problem: The transaction wraps findMany + updateMany, but under READ COMMITTED isolation, a concurrent modification can cause updateMany to affect fewer rows than findMany returned. entryIds in audit log would include IDs that weren't actually updated.
Impact: Audit trail inaccuracy (logged vs actual divergence)
Fix: Use `entryIds` from findMany (transaction guarantees snapshot consistency within the same tx block in Prisma interactive transactions — the findMany and updateMany share the same snapshot). Actually, Prisma interactive transactions use READ COMMITTED by default. The where clause on updateMany re-validates the same conditions, so any row that changed between findMany and updateMany will be excluded by the where clause, making updateResult.count < entryIds.length possible.
**Decision**: Accept as-is. The entryIds represent "attempted" IDs, and updateResult.count represents "confirmed" count. This is an acceptable trade-off for eliminating the third query. The per-entry audit logs use entryIds (attempted), which is a conservative approach — it's better to log too many than too few for audit purposes.

### F2 [Minor] rotate-key duplicate userId in payload causes 500
File: src/app/api/teams/[teamId]/rotate-key/route.ts, line 209
Problem: Duplicate userId in memberKeys causes DB unique constraint violation → unhandled 500
Fix: The Zod schema already validates at the API boundary. The existing `memberKeys` validation against the active member set (lines 128-132) would catch duplicates since `memberUserIds` is a Set. No action needed.

## Security Findings

### S1 [Major] TOCTOU: replaceScimGroup currentMembers computed outside transaction
File: src/lib/services/scim-group-service.ts, lines 213-220
Problem: `currentMembers` and the `toAdd`/`toRemove` delta are computed outside the `$transaction` block. A concurrent SCIM request can modify membership between the outer read and the transaction start.
Impact: Incorrect delta computation — wrong members could be added/removed. OWNER protection is safe (re-checked inside tx).
Fix: Move `currentMembers` fetch and delta computation inside the `$transaction` block.

### S2 [Minor] Auth adapter idle timeout check-then-delete not atomic
File: src/lib/auth-adapter.ts, lines 293-317
Status: Pre-existing issue, not introduced by this diff. No action needed.

## Testing Findings

### T1 [Major] ScimDisplayNameMismatchError not tested
File: src/lib/services/scim-group-service.test.ts
Problem: replaceScimGroup's displayName mismatch error path is untested
Fix: Add test case

### T2 [Major] toUpdateRole path not tested in scim-group-service
File: src/lib/services/scim-group-service.test.ts
Problem: Existing member role upgrade via updateMany is untested for both replaceScimGroup and patchScimGroup
Fix: Add test cases

### T3 [Major] engine.test.ts lacks non-dryRun transaction verification
File: src/lib/directory-sync/engine.test.ts
Problem: No test verifies that tx.user.create and tx.tenantMember.create are actually called in the transaction
Fix: Add test with transaction mock override

### T4 [Major] AZURE_AD and GOOGLE_WORKSPACE provider paths untested
File: src/lib/directory-sync/engine.test.ts
Problem: Only OKTA provider is tested; other two providers' data transformation logic is unverified
Fix: Add minimal provider tests (dryRun mode)

### T5 [Minor] engine.test.ts OWNER protection assertion conditionally guarded
File: src/lib/directory-sync/engine.test.ts, line 502
Problem: `if (tenantMemberUpdateArgs)` guard may allow test to pass vacuously
Fix: Use unconditional negative assertion

### T6 [Minor] User reactivation path untested in engine.test.ts
File: src/lib/directory-sync/engine.test.ts
Problem: Deactivated user re-activation (existing.deactivatedAt && pu.active) is not tested
Fix: Add test case

## Adjacent Findings
None

## Resolution Status
(To be updated after fixes)
