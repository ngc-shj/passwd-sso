# Code Review: ux-send-hibp-google-warnings
Date: 2026-04-05
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### CR-1 [Minor]: parseAllowedGoogleDomains mock duplicates implementation
- **File:** `src/app/[locale]/auth/signin/page.test.ts:31-40`
- **Problem:** Mock re-implemented the actual function logic, risking silent divergence
- **Fix:** Replaced with `vi.fn()` + `mockReturnValue()` per test case

### CR-4 [Minor]: Test description mildly misleading (skipped)
- **Problem:** Test says "shows server-side encryption notice" but actually checks key name
- **Action:** Skipped — matches existing project test pattern

## Security Findings

### CR-3 [Minor]: sendEncryptionNotice mentions E2E comparison (accepted)
- **File:** `messages/en/Share.json:103`
- **Problem:** Wording compares with E2E encryption, disclosing architecture
- **Action:** Accepted — existing `personalShareWarning` already discloses equivalent info. Transparency for users outweighs marginal info disclosure risk.

## Testing Findings

### CR-2 [Minor]: AUTH_GOOGLE env vars not restored in multi-domain hint tests
- **File:** `src/app/[locale]/auth/signin/page.test.ts:301-352`
- **Problem:** Tests set AUTH_GOOGLE_ID/SECRET but didn't restore them in afterEach
- **Fix:** Added save/restore pattern for Google env keys in the describe block

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status

### CR-1 [Minor] Mock duplicates implementation
- Action: Replaced inline mock with `vi.hoisted(() => vi.fn())` + `mockReturnValue()` per test
- Modified file: `src/app/[locale]/auth/signin/page.test.ts:31-35`

### CR-2 [Minor] AUTH_GOOGLE env vars not restored
- Action: Added `googleEnvKeys` save/restore in beforeEach/afterEach within multi-domain hint describe block
- Modified file: `src/app/[locale]/auth/signin/page.test.ts:302-316`

### CR-3 [Minor] E2E comparison in sendEncryptionNotice
- Action: Accepted as-is — transparency for users is the design intent

### CR-4 [Minor] Test description
- Action: Skipped — matches existing project conventions
