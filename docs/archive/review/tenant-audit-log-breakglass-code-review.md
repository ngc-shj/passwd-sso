# Code Review: tenant-audit-log-breakglass
Date: 2026-03-15T12:00:00+09:00
Review round: 2

## Round 1 Findings

### Functionality Expert

| ID | Severity | File | Problem | Status |
|----|----------|------|---------|--------|
| F-C1 | Critical | breakglass-grant-list.tsx | API returns `items`, client reads `grants` | Resolved |
| F-C2 | Critical | breakglass-grant-list.tsx | Status enum case mismatch (ACTIVE vs active) | Resolved |
| F-C3 | Critical | breakglass-grant-list.tsx | Field name `targetUser` vs `target` | Resolved |
| F-C4 | Critical | breakglass-dialog.tsx | Wrong error message for 429 rate limit | Resolved |
| F-M1 | Major | breakglass-dialog.tsx | Missing translation key for rate limit | Resolved |
| F-M2 | Major | API response naming | Inconsistent field names across endpoints | Acknowledged (acceptable) |

### Security Expert

| ID | Severity | File | Problem | Status |
|----|----------|------|---------|--------|
| S-C1 | Critical | breakglass-grant-list.tsx | Same as F-C1 (data binding failure) | Resolved |
| S-C2 | Critical | breakglass-grant-list.tsx | Same as F-C3 (field name mismatch) | Resolved |
| S-M1 | Major | breakglass-dialog.tsx | Same as F-C4 + F-M1 (rate limit UX) | Resolved |
| S-m1 | Minor | breakglass/[id]/logs/route.ts | Unbounded in-memory dedup cache | Acknowledged |
| S-m2 | Minor | breakglass/[id]/logs/route.ts | revokedAt conflates manual/auto expiry | Resolved (R2) |

### User Feedback (incorporated as findings)

| ID | Severity | Problem | Status |
|----|----------|---------|--------|
| UF-1 | Major | Cancel button not i18n | Resolved |
| UF-2 | Major | Member list empty (data.members vs array) | Resolved |
| UF-3 | Major | Break-Glass section position unclear | Resolved (moved above logs) |

### Additional Improvements

| ID | Severity | Problem | Status |
|----|----------|---------|--------|
| AI-1 | Minor | Grant status values not constants | Resolved (GRANT_STATUS added) |

## Round 2 Findings

### Functionality Expert

| ID | Severity | File | Problem | Status |
|----|----------|------|---------|--------|
| F2-F1 | Major | breakglass/[id]/logs/route.ts:84-91 | Lazy expiry sets revokedAt, corrupts EXPIRED vs REVOKED status | Resolved |
| F2-F2 | Major | breakglass/[id]/logs/route.ts:141-167 | VIEW audit fire-and-forget violates non-repudiation | Resolved |
| F2-F3 | Major | breakglass/route.ts:92-151 | TOCTOU: duplicate check and create in separate transactions | Resolved |
| F2-F4 | Minor | breakglass-dialog.tsx:87-88 | All 400s mapped to selfAccessError | Resolved |
| F2-F5 | Minor | breakglass-dialog.tsx:50-57 | Deactivated members shown in dropdown | Resolved |
| F2-F6 | Minor | breakglass/[id]/logs/route.ts:94 | EXPIRE audit write outside RLS context | Resolved (subsumed by F2-F1) |
| F2-F7 | Minor | audit-logs/download/route.ts:73 | Date range not required for download | Resolved |

### Security Expert

| ID | Severity | File | Problem | Status |
|----|----------|------|---------|--------|
| S2-M3 | Major | migration.sql | Missing DB-level RLS policy on personal_log_access_grants | Resolved |
| S2-M4 | Major | breakglass/[id]/logs/route.ts:94 | EXPIRE audit uses bare prisma → RLS failure | Resolved (via F2-F1) |
| S2-M5 | Major | breakglass/[id]/logs/route.ts:144 | VIEW audit non-blocking violates non-repudiation | Resolved (via F2-F2) |
| S2-M6 | Minor | breakglass/route.ts:93-151 | TOCTOU duplicate check | Resolved (via F2-F3) |
| S2-M7 | Minor | audit-logs/download/route.ts:72 | Date range not required | Resolved (via F2-F7) |

## Resolution Status

### F-C1 [Critical] API response items vs grants
- Action: Changed client from `data.grants` to `data.items`
- Modified file: src/components/breakglass/breakglass-grant-list.tsx:51

### F-C2 [Critical] Status enum case mismatch
- Action: Changed to lowercase + GRANT_STATUS constants
- Modified files: breakglass-grant-list.tsx, breakglass/route.ts, constants/breakglass.ts (new)

### F-C3 [Critical] Field name targetUser vs target
- Action: Updated client interface and all references to use `targetUser`
- Modified file: src/components/breakglass/breakglass-grant-list.tsx

### F-C4 [Critical] Wrong 429 error message
- Action: Added `rateLimitExceeded` translation key, used for 429
- Modified files: breakglass-dialog.tsx, messages/en/Breakglass.json, messages/ja/Breakglass.json

### F2-F1 [Major] Lazy expiry corrupts status
- Action: Removed revokedAt update on expiry; added expireAuditCache dedup; moved audit write inside withTenantRls
- Modified file: src/app/api/tenant/breakglass/[id]/logs/route.ts:80-113

### F2-F2 [Major] VIEW audit non-repudiation
- Action: Changed from fire-and-forget to blocking await; return 503 on failure; cache updated only after success
- Modified file: src/app/api/tenant/breakglass/[id]/logs/route.ts:139-162

### F2-F3 [Major] TOCTOU duplicate check
- Action: Merged duplicate check and grant creation into single withTenantRls call
- Modified file: src/app/api/tenant/breakglass/route.ts:86-148

### S2-M3 [Major] Missing RLS policy
- Action: Added ENABLE/FORCE ROW LEVEL SECURITY and tenant_isolation policy to migration
- Modified file: prisma/migrations/.../migration.sql

### F2-F4 [Minor] 400 error handling
- Action: Check response details.targetUserId for self-access; generic fallback otherwise
- Modified file: src/components/breakglass/breakglass-dialog.tsx:86-92

### F2-F5 [Minor] Deactivated members in dropdown
- Action: Filter out members with deactivatedAt in client-side fetch
- Modified file: src/components/breakglass/breakglass-dialog.tsx:53-57

### F2-F7 [Minor] Download date range
- Action: Added validation requiring at least from or to parameter
- Modified file: src/app/api/tenant/audit-logs/download/route.ts:72-74
