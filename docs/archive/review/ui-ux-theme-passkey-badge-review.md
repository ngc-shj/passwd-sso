# Plan Review: ui-ux-theme-passkey-badge
Date: 2026-04-06
Review round: 2

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Critical] ThemeProvider placement causes Toaster to lose theme context
- **File**: `src/app/[locale]/layout.tsx`
- **Problem**: Plan says "wrap children inside NextIntlClientProvider, outside SessionProvider" which is ambiguous. ThemeProvider must be placed INSIDE NextIntlClientProvider so that Toaster (which calls `useTheme()` in `src/components/ui/sonner.tsx`) is within ThemeProvider context.
- **Impact**: Toaster won't reflect theme changes; potential hydration mismatch.
- **Recommended action**: Specify provider order explicitly:
  ```
  NextIntlClientProvider > ThemeProvider > SessionProvider > VaultProvider > {children} + Toaster
  ```

### F2 [Major] Multi-account provider query undefined
- **File**: `src/app/api/user/auth-provider/route.ts` (new)
- **Problem**: Users can have multiple Account records (e.g., Google + Magic Link). Plan doesn't define how to determine "is this user OIDC/SAML2-only". Single `findFirst` query returns arbitrary provider. Also needs `withBypassRls` for Account table access.
- **Impact**: Incorrect badge display for multi-provider users.
- **Recommended action**: Query all accounts for the user. Return a boolean `canPasskeySignIn` (true if user has no OIDC/SAML-only constraint) rather than raw provider string. Use `withBypassRls` as in `auth-adapter.ts`.

### F3 [Major] Extension suppression flow incomplete in handleConfirmCreate
- **File**: `extension/src/content/webauthn-bridge-lib.ts:109-150`
- **Problem**: `handleConfirmCreate` branches on `dupResponse` fields (entries, vaultLocked) but won't handle new `suppressed` field. Banner will still show.
- **Impact**: Passkey save banner still appears on own app despite background suppression.
- **Recommended action**: Add `suppressed` handling to `handleConfirmCreate` — when `PASSKEY_CHECK_DUPLICATE` returns `{ suppressed: true }`, call `respond(requestId, { action: "platform" })` immediately.

### F4 [Minor] Theme translation namespace not in NS_GLOBAL
- **File**: `src/i18n/namespace-groups.ts`, `messages/*/Dashboard.json`
- **Problem**: Dashboard namespace is not in NS_GLOBAL. ThemeToggle in Header needs translations on all pages (including admin).
- **Impact**: Theme labels show as raw keys on admin pages.
- **Recommended action**: Add theme keys to a namespace already in NS_GLOBAL (e.g., Common.json), or create a new ThemeToggle-specific namespace and add it to NS_GLOBAL.

## Security Findings

### S1 [Major] Proxy middleware protection gap for /api/user/auth-provider
- **File**: `src/proxy.ts`, `src/lib/constants.ts`
- **Problem**: `/api/user/auth-provider` not in proxy protected routes list. IP access restriction policies won't apply.
- **Impact**: Endpoint bypasses proxy-level access restriction (tenant IP policy).
- **Recommended action**: Add `USER_AUTH_PROVIDER` to `API_PATH` and `src/proxy.ts` protection list.

### S2 [Minor] Raw provider string exposure
- **Problem**: Returning raw DB strings (e.g., "saml-jackson") leaks implementation details.
- **Recommended action**: Return normalized values or boolean `canPasskeySignIn` instead.

### S3 [Minor] isOwnAppPage() documentation
- **Problem**: `isOwnAppPage()` is UX suppression, not security guard.
- **Recommended action**: Add code comment clarifying `isSenderAuthorizedForRpId` is the security boundary.

## Testing Findings

### T1 [Critical] No route test for /api/user/auth-provider
- **File**: `src/app/api/user/auth-provider/route.test.ts` (missing)
- **Problem**: Existing pattern (e.g., `/api/user/locale/route.test.ts`) covers 401, 200, DB error cases.
- **Impact**: Auth bypass, RLS issues undetected.
- **Recommended action**: Create route.test.ts following existing pattern.

### T2 [Major] No next-themes mock pattern for ThemeToggle tests
- **File**: new `src/components/layout/theme-toggle.test.tsx`
- **Problem**: `useTheme` mock not established in project.
- **Recommended action**: Establish mock: `vi.mock("next-themes", ...)` and add ThemeToggle render/interaction tests.

### T3 [Major] No PasskeyCredentialsCard conditional badge test
- **File**: new `src/components/settings/passkey-credentials-card.test.tsx`
- **Problem**: Conditional badge rendering for OIDC/SAML2 untested.
- **Recommended action**: Test badge visibility with mocked auth-provider response.

### T4 [Major] No PASSKEY_* suppression tests in background.test.ts
- **File**: `extension/src/background/background.test.ts`
- **Problem**: LOGIN_DETECTED suppression tested; PASSKEY_* handlers not.
- **Recommended action**: Add describe block for passkey own-app suppression.

### T5 [Major] No webauthn-bridge-lib suppression test
- **File**: `extension/src/content/__tests__/webauthn-bridge-lib.test.ts`
- **Problem**: Bridge handling of suppressed response untested.
- **Recommended action**: Test handleConfirmCreate with suppressed dupResponse.

### T6 [Minor] jsdom environment annotation for new tests
- **Recommended action**: New component tests must include `// @vitest-environment jsdom`.

## Round 2 Results

All Round 1 findings (F1-F4, S1-S3, T1-T6) resolved in plan update.

New findings from Round 2:
- F5 [Minor] BYPASS_PURPOSE value unspecified → RESOLVED (AUTH_FLOW added to plan)
- F6 [Major] handleGetMatches MAIN world suppressed handling → REJECTED (false finding: MAIN world interceptor already falls through to origGet when entries is empty, no change needed)
- F7/F8 [Major/Minor] File path error: src/lib/constants.ts → src/lib/constants/api-path.ts → RESOLVED (path corrected)
- T7 [Major] Test-implementation correspondence unclear → RESOLVED (test plan clarified with implementation dependencies)
- T8 [Major] isOwnAppPage mock trigger conditions → RESOLVED (serverUrl + sender URL prerequisites documented)
- T9 [Minor] header.test.tsx theme-toggle mock → RESOLVED (mock added to plan)
- T10 [Minor] withBypassRls mock pattern → RESOLVED (mock pattern added to plan)
- N1/Security [Minor] BYPASS_PURPOSE unspecified → RESOLVED (same as F5)

## Adjacent Findings
None.

## Quality Warnings
None.
