# Code Review: unify-callback-url
Date: 2026-03-16
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Minor] Wrapper div produces 16px gap when banner is absent
- **Status:** Resolved — ExtConnectBanner now accepts className prop; wrapper div removed

## Security Findings

### S1 [Minor] callbackUrlToHref input constraint not documented
- **Status:** Skipped — JSDoc already describes the function's purpose and expected input

### S2 [Minor] ExtConnectBanner includes() is UI-only
- **Status:** Skipped — no security impact (UI display only, no auth/authz effect)

## Testing Findings

### T1 [Major] callbackUrlToHref missing BASE_PATH non-empty tests
- **Status:** Resolved — added callback-url-basepath.test.ts with mocked BASE_PATH="/passwd-sso"

### T2 [Major] ExtConnectBanner has no tests
- **Status:** Resolved — added ext-connect-banner.test.tsx (4 test cases)

### T3 [Minor] auto-extension-connect.test.tsx stale comment
- **Status:** Resolved — updated comment to reflect removed Close tab button

### T4 [Minor] jsdom origin implicit dependency
- **Status:** Skipped — standard jsdom testing pattern, consistent with other hook tests

## Adjacent Findings
None

## Resolution Status

### F1 [Minor] Wrapper div gap
- Action: Added className prop to ExtConnectBanner, removed wrapper div
- Modified file: src/components/extension/ext-connect-banner.tsx, src/components/vault/vault-lock-screen.tsx

### T1 [Major] BASE_PATH non-empty test coverage
- Action: Created separate test file with vi.mock for BASE_PATH="/passwd-sso"
- Modified file: src/lib/callback-url-basepath.test.ts

### T2 [Major] ExtConnectBanner test coverage
- Action: Created test file with 4 cases (direct, indirect, absent, className)
- Modified file: src/components/extension/ext-connect-banner.test.tsx

### T3 [Minor] Stale comment
- Action: Updated comment to remove "Close tab" reference
- Modified file: src/components/extension/auto-extension-connect.test.tsx
