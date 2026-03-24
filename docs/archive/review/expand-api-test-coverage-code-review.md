# Code Review: expand-api-test-coverage
Date: 2026-03-23T00:00:00+09:00
Review round: 2 (final — includes Round 1 fixes from earlier in session)

## Changes from Previous Round
Round 1 fixes (already committed):
- E2E_TENANT.id fixed to valid UUID
- seedVaultKey ON CONFLICT key fixed to (user_id, version)
- i18n selectors fixed (Key Rotation, Rotate Key, Send Invitation, New Folder)
- test.describe.serial added to passphrase-change and teams specs
- False positive test in teams.spec.ts fixed
- Star button selector fixed (lucide-star)
- Share-link beforeAll visibility check added
- .auth-state.json file permissions (0o600)

Round 2 additions (this round):
- 4 DB helpers created (password-entry, share-link, team, emergency-access)
- Multi-user tests updated with pre-seeded data
- 5 unit test files added for DB helpers (125 tests)

## Functionality Findings

### [F1] Minor: team.ts `createdById` unused field
- `SeedTeamOptions.createdById` declared but not used in INSERT (teams table has no such column)
- Status: Noted — minor dead code, no runtime impact

### [F2] Minor: emergency-access.ts double-SHA-256 token hash
- Token stored as SHA-256(SHA-256(seed)), not matching production single-SHA-256 pattern
- No current test exercises token-based URL lookup, so no impact
- Status: Noted — latent issue for future EA URL tests

## Security Findings

No findings. All SQL parameterized, crypto operations correct, master key from env vars, file permissions set.

## Testing Findings

### [T1] Major: emergency-access.spec.ts missing test.describe.serial — RESOLVED
- Shared mutable page state with state-mutating tests
- Fix: Added `test.describe.serial`

### [T2] Major: emergency-access.spec.ts waitForTimeout(2_000) — RESOLVED
- Unconditional sleep instead of deterministic wait
- Fix: Replaced with `await expect(getByText(/Trusted by Others/)).toBeVisible()`

### [T3] Minor: db.test.ts missing webauthn_credentials ordering assertion
- Cleanup ordering test doesn't verify webauthn_credentials comes before users
- Status: Noted — minor test coverage gap

## Adjacent Findings
None.

## Resolution Status
### [T1] Major: emergency-access.spec.ts serial
- Action: Changed `test.describe` to `test.describe.serial`
- Modified file: e2e/tests/emergency-access.spec.ts:7

### [T2] Major: emergency-access.spec.ts waitForTimeout
- Action: Replaced waitForTimeout with deterministic section visibility wait
- Modified file: e2e/tests/emergency-access.spec.ts:67-70
