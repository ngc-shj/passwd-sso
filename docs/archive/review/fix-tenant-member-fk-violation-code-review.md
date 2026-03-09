# Code Review: fix/tenant-member-fk-violation

Date: 2026-03-09
Review rounds: 2

## Summary

Fixed a foreign key constraint violation (`tenant_members_user_id_fkey`) during Google Workspace OAuth sign-in. Auth.js v5 may provide a pre-generated user ID in the `signIn` callback before the user row is persisted. The fix always verifies user existence via email DB lookup instead of trusting `params.user?.id`.

## Round 1

### Functionality Findings

- Minor: Duplicate `user.findUnique` call for nodemailer provider (existing lookup at L255-263 + new lookup at L275-280). Deferred as optimization — no functional impact.

### Security Findings

No findings. The change improves security posture by preventing operations with non-existent user IDs.

### Testing Findings

- **[Critical]** signIn callback had zero test coverage. Fixed in Round 2.
- **[Major]** `mockPrisma.user.findUnique` missing from test mock. Fixed in Round 2.
- Minor: Duplicate `user.findUnique` for nodemailer may cause test assertion confusion. Accepted.

## Round 2

### Changes from Round 1

1. Added `user.findUnique: vi.fn()` to `mockPrisma`
2. Added 4 signIn callback tests:
   - New user with pre-generated ID (no DB row) → returns true, no upsert
   - Existing user → uses DB ID, not pre-generated ID
   - User with no email → skips lookup, returns true
   - Existing user with tenant claim → upsert receives real DB ID

### All Agents: No findings

## Resolution Status

### [Critical] signIn callback test coverage

- Action: Added 4 test cases covering the behavioral change
- Modified file: src/auth.test.ts

### [Major] Missing user.findUnique mock

- Action: Added `findUnique: vi.fn()` to mockPrisma.user
- Modified file: src/auth.test.ts:22

### [Minor] Duplicate user.findUnique for nodemailer

- Action: Accepted — no functional impact, optimization deferred

### [Minor] Variable naming (lookupEmail)

- Action: Accepted — clearer intent than `email` which could shadow other variables
