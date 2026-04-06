# UI/UX Improvements Plan

## Objective
Fix three UI/UX issues: (1) add dark/light theme toggle, (2) hide misleading passkey sign-in badge for OIDC/SAML2 users, (3) suppress extension passkey save banner on own app pages.

## Requirements
- Theme toggle must work on all pages (dashboard, admin, settings)
- Passkey badge must correctly reflect whether the user can actually use passkey sign-in
- Extension must not offer to save passkeys when on passwd-sso's own WebAuthn registration page

---

## Issue 1: Theme Toggle (Dark/Light Mode)

### Background
The app has full dark mode CSS support (CSS variables in `globals.css`, 112+ `dark:` Tailwind classes) and `next-themes` v0.4.6 installed, but no ThemeProvider or UI toggle exists.

### Plan

#### 1a. Create ThemeProvider component
- **File**: `src/components/providers/theme-provider.tsx`
- Wrap `next-themes` `ThemeProvider` with:
  - `attribute="class"`
  - `defaultTheme="system"`
  - `enableSystem`
  - `disableTransitionOnChange`
- Export as `"use client"` component

#### 1b. Add ThemeProvider to locale layout
- **File**: `src/app/[locale]/layout.tsx`
- Provider nesting order (critical — Toaster uses `useTheme()` and must be inside ThemeProvider):
  ```
  NextIntlClientProvider
    ThemeProvider          ← NEW
      SessionProvider
        VaultProvider
          {children}
          <Toaster />     ← inside ThemeProvider context
  ```

#### 1c. Create ThemeToggle component
- **File**: `src/components/layout/theme-toggle.tsx`
- Three-state toggle: light / dark / system
- Use `DropdownMenu` (consistent with existing header dropdowns)
- Icons: `Sun`, `Moon`, `Monitor` from lucide-react
- Use `useTheme()` from `next-themes`
- Use `useTranslations("Common")` for labels (Common is in NS_GLOBAL, available on all pages)

#### 1d. Add ThemeToggle to Header
- **File**: `src/components/layout/header.tsx`
- Place between `LanguageSwitcher` and `NotificationBell`
- Guard with `mounted` state (same pattern as LanguageSwitcher)

#### 1e. Add i18n translations
- **Files**: `messages/ja/Common.json`, `messages/en/Common.json`
- Keys: `theme`, `themeLight`, `themeDark`, `themeSystem`
- Rationale: Common namespace is in NS_GLOBAL, ensuring translations are available on all pages including admin

---

## Issue 2: Passkey Sign-in Capability Check for OIDC/SAML2 Users

### Background
When a user authenticates via OIDC (Google) or SAML2 (BoxyHQ Jackson), passkey sign-in is not available as a login method. The "パスキーログイン" (Passkey sign-in) badge on registered passkeys is misleading because:
- OIDC/SAML2 users cannot use passkeys to sign in
- The badge implies the passkey can be used for login when it cannot
- Passkeys for these users are only useful for vault unlock (PRF) and offline backup

### Plan

#### 2a. Create API endpoint to check passkey sign-in capability
- **File**: `src/app/api/user/auth-provider/route.ts`
- **Auth**: Use `auth()` for session check (route-handler auth pattern)
- **Proxy protection**: Add `USER_AUTH_PROVIDER = "/api/user/auth-provider"` to `API_PATH` in `src/lib/constants.ts` and add `pathname.startsWith(API_PATH.USER_AUTH_PROVIDER)` to `src/proxy.ts` protected route list
- **DB query**: Use `withBypassRls(prisma, fn, BYPASS_PURPOSE.AUTH_FLOW)` to query `Account` table (same purpose as `auth-adapter.ts` Account queries)
- **Multi-account handling**: Query ALL accounts for the user (`findMany` with `userId`), then determine:
  - If user has ONLY OIDC/SAML providers (google, saml-jackson) → `canPasskeySignIn: false`
  - If user has any local auth provider (passkey, nodemailer) → `canPasskeySignIn: true`
- **Response**: `{ canPasskeySignIn: boolean }` (not raw provider string — avoid leaking internal implementation details)

#### 2b. Add conditional badge rendering to PasskeyCredentialsCard
- **File**: `src/components/settings/passkey-credentials-card.tsx`
- Fetch `/api/user/auth-provider` on mount
- When `canPasskeySignIn === false`:
  - Show "パスキーログイン" badge as disabled (grayed out, line-through) with tooltip explaining the limitation
- When `canPasskeySignIn === true` (or fetch fails — fail open for UX):
  - Show badge normally (existing behavior)

#### 2c. Update i18n translations
- **Files**: `messages/ja/WebAuthn.json`, `messages/en/WebAuthn.json`
- Add key: `discoverableDisabledOidc` — "OIDC/SAML認証ではパスキーログインは利用できません" / "Passkey sign-in is not available with OIDC/SAML authentication"

#### 2d. Decision: Don't hide entire passkey registration
- Passkeys are still useful for: vault unlock via PRF, offline backup via largeBlob
- Only the "sign-in" badge needs adjustment

---

## Issue 3: Browser Extension Passkey Save Banner on Own App

### Background
The browser extension suppresses ID/password save banners on passwd-sso's own pages via `isOwnAppPage()` check (`extension/src/background/index.ts:2104`, `:2221`). However, the passkey message handlers (`PASSKEY_GET_MATCHES`, `PASSKEY_CHECK_DUPLICATE`, `PASSKEY_CREATE_CREDENTIAL` at lines 2346-2391) lack this check. When a user registers a passkey on passwd-sso's own WebAuthn page, the extension's WebAuthn interceptor triggers `showPasskeySaveBanner()` — offering to save the passkey as a vault entry, which is meaningless (passkeys are device-bound, not storable credentials).

### Plan

#### 3a. Add `isOwnAppPage()` check to passkey message handlers
- **File**: `extension/src/background/index.ts`
- For `PASSKEY_GET_MATCHES` (line 2346): check `_sender.tab?.url` with `isOwnAppPage()`, return `{ entries: [], suppressed: true }`
- For `PASSKEY_CHECK_DUPLICATE` (line 2352): return `{ exists: false, suppressed: true }` if own app
- For `PASSKEY_CREATE_CREDENTIAL` (line 2373): return `{ ok: false, suppressed: true }` if own app
- Note: `isOwnAppPage()` is for UX suppression only; `isSenderAuthorizedForRpId` in `passkey-provider.ts` remains the security boundary (add code comment to clarify)

#### 3b. Handle suppression in content script bridge
- **File**: `extension/src/content/webauthn-bridge-lib.ts`
- `handleConfirmCreate()` (line 109): in the `PASSKEY_CHECK_DUPLICATE` response handling, check for `suppressed: true` BEFORE checking `entries`/`vaultLocked`. When suppressed, call `respond(requestId, { action: "platform" })` immediately to fall through to native WebAuthn without showing the save banner
- `handleGetMatches()`: when background returns `{ entries: [], suppressed: true }`, skip showing passkey dropdown and respond with empty selection

#### 3c. Suppression response convention
- All suppressed passkey responses include `suppressed: true` field
- Content script checks `suppressed` flag first in all passkey response handlers
- WebAuthn interceptor in MAIN world falls through to browser's native `navigator.credentials.create()` seamlessly (existing "platform" action already does this)

---

## Testing Strategy

### Issue 1 Tests
- `src/components/layout/theme-toggle.test.tsx` (`// @vitest-environment jsdom`)
  - Mock `next-themes` `useTheme()`: `vi.mock("next-themes", () => ({ useTheme: vi.fn().mockReturnValue({ theme: "light", setTheme: vi.fn(), resolvedTheme: "light" }), ThemeProvider: ({ children }) => children }))`
  - Test: renders three options (light/dark/system)
  - Test: calls `setTheme()` on selection
- Update `src/components/layout/header.test.tsx`
  - Add mock for `./theme-toggle` (same pattern as existing `./language-switcher` and `notification-bell` mocks)
  - Verify ThemeToggle renders in header

### Issue 2 Tests
- `src/app/api/user/auth-provider/route.test.ts`
  - Follow existing pattern (mockAuth, mockPrisma, createRequest helpers)
  - Mock `withBypassRls`: `vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()), withBypassRls: vi.fn((_prisma, fn) => fn()) }))`
  - Test: 401 without session
  - Test: 200 with canPasskeySignIn=true (user has passkey provider)
  - Test: 200 with canPasskeySignIn=false (user has only google provider)
  - Test: 200 with canPasskeySignIn=true (user has both google + nodemailer)
  - Test: DB error → 500

### Issue 3 Tests
- Update `extension/src/background/background.test.ts`
  - Add describe block "PASSKEY handlers suppress on own app"
  - Prerequisite: existing `installChromeMock` sets `serverUrl: "https://localhost:3000"` in `chrome.storage.local.get`. Use sender URL `https://localhost:3000/dashboard/settings/security/passkey` to trigger `isOwnAppPage() → true`
  - Test: PASSKEY_GET_MATCHES returns `{ entries: [], suppressed: true }` on own app URL
  - Test: PASSKEY_CHECK_DUPLICATE returns `{ exists: false, suppressed: true }` on own app URL
- Update `extension/src/content/__tests__/webauthn-bridge-lib.test.ts`
  - Test: handleConfirmCreate with suppressed dupResponse (`{ suppressed: true }`) → responds with `{ action: "platform" }` without showing banner

All new test files must include `// @vitest-environment jsdom` when testing DOM components.

---

## Considerations & Constraints
- Theme preference stored in localStorage only (via next-themes default). No DB persistence needed.
- `isOwnAppPage()` depends on `serverUrl` being set in chrome.storage.local. If unset, returns false (banner shows — acceptable UX degradation, not a security issue).
- Fail-open for passkey badge: if `/api/user/auth-provider` fetch fails, show badge normally (don't degrade existing UX).

---

## User Operation Scenarios

### Scenario 1: Theme Toggle
1. User opens dashboard → header shows theme toggle button (sun/moon icon)
2. User clicks toggle → dropdown shows Light / Dark / System options
3. User selects Dark → page immediately switches to dark mode
4. User navigates to admin settings → dark mode persists (localStorage)
5. User refreshes page → dark mode persists (no flash)

### Scenario 2: OIDC User Views Passkey Settings
1. User signed in via Google OIDC → navigates to Settings > Security > Passkey
2. User has registered a passkey (for PRF vault unlock)
3. "パスキーログイン" badge shows as grayed out with line-through
4. User hovers badge → tooltip: "OIDC/SAML認証ではパスキーログインは利用できません"
5. "保管庫のロック解除" badge shows normally (PRF still works)

### Scenario 3: User with Multiple Auth Providers
1. User originally signed up via Magic Link, later linked Google account
2. User has both "nodemailer" and "google" Account records
3. API returns `canPasskeySignIn: true` (has local auth)
4. Badge shows normally

### Scenario 4: Extension on Own App
1. User opens passwd-sso WebAuthn settings page in browser
2. User clicks "Register new passkey" → browser's native WebAuthn dialog appears
3. Extension detects `navigator.credentials.create()` call
4. Extension background checks `isOwnAppPage()` → true
5. Extension returns suppressed response → NO save banner shown
6. Native WebAuthn registration completes normally

---

## Files to Create
1. `src/components/providers/theme-provider.tsx`
2. `src/components/layout/theme-toggle.tsx`
3. `src/app/api/user/auth-provider/route.ts`
4. `src/app/api/user/auth-provider/route.test.ts`
5. `src/components/layout/theme-toggle.test.tsx`

## Files to Modify
1. `src/app/[locale]/layout.tsx` — add ThemeProvider (provider nesting order)
2. `src/components/layout/header.tsx` — add ThemeToggle
3. `src/components/settings/passkey-credentials-card.tsx` — conditional badge
4. `src/lib/constants/api-path.ts` — add USER_AUTH_PROVIDER to API_PATH
5. `src/proxy.ts` — add auth-provider to protected routes
6. `messages/ja/Common.json` — theme translations
7. `messages/en/Common.json` — theme translations
8. `messages/ja/WebAuthn.json` — OIDC disclaimer
9. `messages/en/WebAuthn.json` — OIDC disclaimer
10. `extension/src/background/index.ts` — add isOwnAppPage() check to passkey handlers
11. `extension/src/content/webauthn-bridge-lib.ts` — handle suppression response
12. `extension/src/background/background.test.ts` — passkey suppression tests
13. `extension/src/content/__tests__/webauthn-bridge-lib.test.ts` — suppression test
