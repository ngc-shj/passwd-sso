# Plan: unify-callback-url

## Context

When the browser extension opens `/dashboard?ext_connect=1` and the user is not signed in, the proxy middleware correctly preserves `ext_connect=1` in the `callbackUrl` parameter during redirect to sign-in. However, only the SSO sign-in component (`SignInButton`) reads and uses this `callbackUrl` after authentication. Passkey, SecurityKey, and Email sign-in methods hard-code `router.push("/dashboard")`, causing the `ext_connect=1` parameter to be lost. As a result, the extension never receives its connection token.

The callbackUrl resolution logic (with open-redirect protection) is duplicated inline in `SignInButton` and absent from all other sign-in components. This plan extracts it into a shared utility and ensures all sign-in paths use it.

## Requirements

1. Extract callbackUrl resolution into a shared pure function + React hook
2. All sign-in components use the shared hook for post-auth redirect
3. Maintain open-redirect protection (relative paths or same-origin only)
4. Fix protocol-relative URL bypass (`//evil.com`) in existing logic
5. Fix sign-in page's already-logged-in redirect to respect callbackUrl

## Technical Approach

### New files

**`src/lib/callback-url.ts`** — Pure function `resolveCallbackUrl(raw: string | null, origin: string): string`
- Returns validated relative path (e.g., `/ja/dashboard?ext_connect=1`)
- Default: `${BASE_PATH}/dashboard` (uses `BASE_PATH` constant directly, not `withBasePath` function — safe for both client and server)
- Accepts relative paths starting with `/` (but rejects `//` protocol-relative and `\` backslash)
- Accepts same-origin absolute URLs, extracts `pathname + search`
- Rejects cross-origin URLs and malformed input

**`src/hooks/use-callback-url.ts`** — React hook `useCallbackUrl(): string`
- Reads `callbackUrl` from `useSearchParams()`
- Calls `resolveCallbackUrl(raw, window.location.origin)`
- Returns validated path

### Modified files

| # | File | Change |
|---|------|--------|
| 1 | `src/components/auth/signin-button.tsx` | Replace inline logic with `useCallbackUrl()` |
| 2 | `src/components/auth/passkey-signin-button.tsx` | Add `useCallbackUrl()`, use `stripLocalePrefix(callbackUrl)` in `router.push()` |
| 3 | `src/components/auth/security-key-signin-form.tsx` | Same as passkey |
| 4 | `src/components/auth/email-signin-form.tsx` | Add `useCallbackUrl()`, pass to `signIn("nodemailer", { callbackUrl, redirect: false })`. **IMPORTANT: `redirect: false` must be preserved** — removing it breaks the Magic Link flow by redirecting before the email is sent |
| 5 | `src/app/[locale]/auth/signin/page.tsx` | Add `searchParams` to Props type (`Promise<{ callbackUrl?: string }>`), use `resolveCallbackUrl` with `getAppOrigin()` for already-logged-in redirect |

### Key design decisions

- **Pure function + hook separation**: The pure function is testable without React; the hook wraps it with `useSearchParams()`
- **`stripLocalePrefix` for Passkey/SecurityKey**: These use `router.push()` from `@/i18n/navigation` which auto-adds locale. The callbackUrl from proxy includes locale (e.g., `/ja/dashboard?ext_connect=1`), so we strip it to avoid double-prefix
- **SSO/Email use Auth.js `signIn()`**: Auth.js handles the redirect internally, so we pass the raw callbackUrl (with locale) directly — no stripping needed
- **SignInPage (server component)**: Cannot use hooks. Import and call `resolveCallbackUrl` directly with origin from `getAppOrigin()` (reads `APP_URL`/`AUTH_URL` env vars, never from request headers). Wrap `new URL(appOrigin).origin` in try-catch for robustness. When env vars are unset, origin is `""` → fail-closed (only relative paths pass through)

## Implementation Steps

1. Create `src/lib/callback-url.ts` with `resolveCallbackUrl`
2. Create `src/lib/callback-url.test.ts` with unit tests
3. Create `src/hooks/use-callback-url.ts` with `useCallbackUrl`
4. Create `src/hooks/use-callback-url.test.ts` (verify return value + args)
5. Modify `src/components/auth/signin-button.tsx` — replace inline logic
6. Modify `src/components/auth/passkey-signin-button.tsx` — add hook + stripLocalePrefix
7. Modify `src/components/auth/security-key-signin-form.tsx` — same as passkey
8. Modify `src/components/auth/email-signin-form.tsx` — add hook + pass to signIn (keep `redirect: false`)
9. Modify `src/app/[locale]/auth/signin/page.tsx` — add `searchParams` Props type, fix already-logged-in redirect with `resolveCallbackUrl` + `getAppOrigin()`
10. Run `npx vitest run` + `npx next build`

## Testing Strategy

### Unit tests for `resolveCallbackUrl` (`src/lib/callback-url.test.ts`)
- `null` → default `/dashboard`
- `/dashboard?ext_connect=1` → passthrough
- `/ja/dashboard?ext_connect=1` → passthrough (locale-prefixed)
- `https://same-origin/dashboard?ext_connect=1` → `/dashboard?ext_connect=1`
- `https://evil.com/phish` → default (cross-origin)
- `//evil.com/phish` → default (protocol-relative rejected)
- `/\evil.com` → default (backslash variant rejected)
- Malformed URL string → default
- Empty string → default
- Origin is empty string → only relative paths pass, absolute URLs rejected

### Hook tests for `useCallbackUrl` (`src/hooks/use-callback-url.test.ts`)
- Mock `useSearchParams`, verify return value matches `resolveCallbackUrl` output
- Verify default value when no callbackUrl param present

### Component tests (in existing or new test files)
- `signin-button.tsx`: verify `signIn()` called with correct callbackUrl
- `passkey-signin-button.tsx`: verify `router.push()` called with `stripLocalePrefix(callbackUrl)`
- `security-key-signin-form.tsx`: same as passkey
- `email-signin-form.tsx`: verify `signIn("nodemailer", { callbackUrl, redirect: false })` — confirm `redirect: false` preserved
- `page.test.ts`: add test for "logged-in + callbackUrl present" → redirect to callbackUrl

### Integration tests
- `stripLocalePrefix` + `resolveCallbackUrl` combination: `/ja/dashboard?ext_connect=1` → stripped to `/dashboard?ext_connect=1`

### Verification
- All tests pass: `npx vitest run`
- Build succeeds: `npx next build`

## Considerations & Constraints

- `stripLocalePrefix` handles query strings correctly (verified: splits on `/`, query stays attached to last segment)
- next-intl `router.push("/dashboard?ext_connect=1")` works with query strings in string form (no pathnames config defined, accepts plain string)
- basePath handling uses `BASE_PATH` constant directly (safe for both client and server)
- Email magic link: Auth.js embeds callbackUrl in the verification URL, so passing it to `signIn()` is sufficient
- `resolveCallbackUrl` is pre-validated before passing to Auth.js — this is the first-line defense regardless of Auth.js `trustHost` settings

## Critical files

- `src/lib/url-helpers.ts` — `BASE_PATH` constant, `getAppOrigin()` for server-side origin
- `src/i18n/locale-utils.ts` — `stripLocalePrefix()` used in passkey/security-key components
- `src/proxy.ts:64` — where callbackUrl is set (context only, not modified)
- `src/components/extension/auto-extension-connect.tsx` — reads `ext_connect` param (context only, not modified)
