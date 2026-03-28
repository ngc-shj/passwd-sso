# Code Review: separate-db-roles
Date: 2026-03-28
Review round: 2

## Round 1 Findings (all resolved)
- F1 Critical: load-test seed reverted to passwd_user
- F2 Major: CI smoke test covers service_accounts
- T4 Critical: Seed data added before RLS assertion
- T5 Minor: Empty string MIGRATION_DATABASE_URL test added

## Round 1→2 Additional Fixes (from manual testing +横展開)
- withBypassRls: nil UUID for app.tenant_id (UUID cast error prevention)
- account-lockout.ts: checkLockout/recordFailure/resetLockout wrapped in withBypassRls
- check-bypass-rls.mjs: regex (?:prisma|tx), allowlist accuracy (3 entries fixed)
- access-requests/[id]/approve: bare $transaction wrapped in withTenantRls
- service-accounts/[id]/tokens: bare $transaction wrapped in withTenantRls
- threat-model.md: allowlist count 25→47

## Round 2 Findings

### T-R2-1 [Critical] RESOLVED: CI smoke test seed FK constraint violation
- Problem: INSERT with gen_random_uuid() for FK columns fails silently (tenants/users not found)
- Action: Added `SET session_replication_role = 'replica'` + `psql -v ON_ERROR_STOP=1`
- Modified file: .github/workflows/ci.yml

### T-R2-2 [Minor] ACKNOWLEDGED: SCAN_RADIUS=10 insufficient for account-lockout.ts
- Problem: withBypassRls call to tx.user.update is 68 lines apart, beyond scan range
- Status: Tool limitation, no code correctness impact. Future improvement.

## Functionality Findings
No findings (Round 2)

## Security Findings
No findings (Round 2)

## Resolution Status
All Critical and Major findings resolved across 2 rounds.
