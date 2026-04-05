# Plan: ux-send-hibp-google-warnings

## Objective

Address three Low-severity review findings by adding UX warnings and code comments to improve user understanding and future maintainability.

## Requirements

### Functional
1. **NEW-3**: Send dialog must display an informational notice that Sends use server-side encryption (not E2E), so users understand the protection level differs from vault entries
2. **NEW-4**: HIBP cache module must include a TODO comment noting Redis migration alignment with proxy.ts session cache
3. **NEW-5**: Google sign-in page must show guidance when multiple workspace domains are configured, helping users select the correct account

### Non-functional
- All UI text must be i18n-aware (ja + en)
- No changes to encryption logic, auth flow, or caching behavior
- Visual style must match existing warning/info patterns in the codebase

## Technical Approach

### NEW-3: Send Dialog Server-Side Encryption Notice
- Add an info banner inside the `!createdUrl` branch of `send-dialog.tsx` (form view only), NOT above the conditional — avoids showing in post-creation URL view
- Use the existing `Info` icon from lucide-react (consistent with other info banners in the app)
- Style: muted info tone (blue/muted) to distinguish from the amber access-password warning — follow the ad-hoc banner pattern used in `ext-connect-banner.tsx` (blue border/bg), `delegation-revoke-banner.tsx` (amber), `recovery-key-banner.tsx` (yellow). No shared Alert component exists in this project.
- Add i18n keys `sendEncryptionNotice` to `Share` namespace in both `messages/en/Share.json` and `messages/ja/Share.json`
- NOTE: `send-e2e-entry-view.tsx` does NOT exist — `send-dialog.tsx` is the only Send creation UI component

### NEW-4: HIBP Cache TODO Comment
- Add a `// TODO:` comment above the `cache` declaration in `watchtower/hibp/route.ts` (line ~17)
- Reference proxy.ts session cache for future Redis unification

### NEW-5: Google Multi-Domain Login Guidance
- Add a helper text below the Google sign-in button in `src/app/[locale]/auth/signin/page.tsx` (the only login page with Google button — no admin login page exists)
- The hint tells users to select an account from one of the allowed domains
- The signin page is a server component — import `parseAllowedGoogleDomains()` from `src/lib/google-domain.ts` (existing shared utility) to get normalized domain list. Check `length > 1` for multi-domain flag. Do NOT re-parse `process.env` directly.
- Domain names should NOT be leaked to the client — only a boolean "multiple domains configured" flag
- Add i18n keys `googleMultiDomainHint` to `Auth` namespace

## Implementation Steps

1. Add i18n keys for NEW-3 (`sendEncryptionNotice`) to `messages/en/Share.json` and `messages/ja/Share.json`
2. Add info banner inside `!createdUrl` branch of `src/components/share/send-dialog.tsx`, using inline `<div>` + Tailwind blue info style + `Info` icon (matching existing ad-hoc banner pattern)
3. Add TODO comment to `src/app/api/watchtower/hibp/route.ts` above cache declaration
4. Add i18n keys for NEW-5 (`googleMultiDomainHint`) to `messages/en/Auth.json` and `messages/ja/Auth.json`
5. In `src/app/[locale]/auth/signin/page.tsx`: import `parseAllowedGoogleDomains()`, detect multi-domain, add hint text below Google sign-in button
6. Run lint, tests, and production build

### Files to modify
- `messages/en/Share.json` — add `sendEncryptionNotice` key
- `messages/ja/Share.json` — add `sendEncryptionNotice` key
- `src/components/share/send-dialog.tsx` — add info banner
- `src/app/api/watchtower/hibp/route.ts` — add TODO comment
- `messages/en/Auth.json` — add `googleMultiDomainHint` key
- `messages/ja/Auth.json` — add `googleMultiDomainHint` key
- `src/app/[locale]/auth/signin/page.tsx` — add multi-domain hint
- `src/components/share/send-dialog.test.tsx` — add banner render test
- `src/app/[locale]/auth/signin/page.test.ts` — add multi-domain hint tests (2 cases)

## Testing Strategy

- **send-dialog.test.tsx**: Add test verifying the encryption notice banner renders (existing mock pattern: `useTranslations` returns key name)
- **signin/page.test.ts**: Add 2 tests for multi-domain hint — shown when `GOOGLE_WORKSPACE_DOMAINS` has multiple domains, hidden when single/unset (existing `process.env` manipulation pattern)
- Existing tests must continue to pass (no logic changes)
- Production build must succeed

## Considerations & Constraints

- NEW-3: Use positive framing ("encrypted in transit and at rest on the server") instead of "not E2E" — avoids unnecessary architecture disclosure per security review
- NEW-4: Pure comment change, zero risk
- NEW-5: Use `parseAllowedGoogleDomains()` from `src/lib/google-domain.ts` to get normalized domain count. Domain names NOT leaked to client — only boolean flag

## User Operation Scenarios

1. **Send creation**: User opens Send dialog → sees info notice about server-side encryption → understands this is different from vault E2E encryption → proceeds to create Send
2. **Google login (multi-domain)**: User visits login page → sees hint about selecting correct domain account → picks correct account → signs in successfully
3. **Google login (single domain)**: User visits login page → no extra hint shown (hd param already filters) → normal flow
