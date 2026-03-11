# Plan Review: extension-unlisted-distribution
Date: 2026-03-11T00:00:00+09:00
Review round: 2 (final)

## Changes from Previous Round
Initial review

## Functionality Findings

### [Major-1] Translation files and NAMESPACES registration order mismatch
- **Severity:** Major
- **Problem:** `PrivacyPolicy.json` files already exist but `NAMESPACES` in `src/i18n/messages.ts` has not been updated. `messages-consistency.test.ts` L51-61 "has no extra files beyond declared namespaces" will fail.
- **Impact:** `npx vitest run` fails immediately.
- **Recommended action:** Register `"PrivacyPolicy"` in `NAMESPACES` as the very first implementation step (before any other changes).

### [Major-2] namespace-groups.test.ts excluded set needs updating
- **Severity:** Major
- **Problem:** `namespace-groups.test.ts` L37-43 expects `NS_DASHBOARD_ALL` to cover all namespaces except `["Metadata", "Recovery", "VaultReset"]`. Adding `PrivacyPolicy` without updating `excluded` will fail the test.
- **Impact:** `npx vitest run` fails.
- **Recommended action:** Add explicit step to update `excluded` set in `namespace-groups.test.ts` with `"PrivacyPolicy"` when adding `NS_PRIVACY_POLICY`.

### [Minor-1] lastUpdated {date} parameter source unspecified
- **Severity:** Minor
- **Problem:** Translation files use `{date}` parameter in `lastUpdated` key, but plan doesn't specify the source (hardcoded, build-time, or runtime).
- **Impact:** Inconsistent implementation risk.
- **Recommended action:** Hardcode the date string in the page component, update manually when policy is revised.

## Security Findings

### [Major-3] NEXT_PUBLIC_CHROME_STORE_URL lacks URL validation
- **Severity:** Major
- **Problem:** No validation that the env var is a legitimate Chrome Web Store URL. Could be set to `javascript:`, `data:`, or phishing URL.
- **Impact:** Open redirect or code execution risk in a password manager context.
- **Recommended action:** Whitelist-validate the URL to start with `https://chrome.google.com/webstore/` or `https://chromewebstore.google.com/` before rendering. Example:
  ```ts
  const isValidStoreUrl = (url: string) =>
    url.startsWith("https://chrome.google.com/webstore/") ||
    url.startsWith("https://chromewebstore.google.com/");
  ```

### [Minor-2] VaultProvider initialized on public privacy-policy page
- **Severity:** Minor
- **Problem:** `/[locale]/privacy-policy` under root layout inherits `SessionProvider` and `VaultProvider`.
- **Impact:** Unnecessary session-related requests on a public page.
- **Recommended action:** Follow recovery pattern — privacy-policy layout should only wrap `NextIntlClientProvider`, not `SessionProvider`/`VaultProvider`. Verify this is achieved by the plan's "follow recovery pattern" approach.

## Testing Findings

### [Major-4] Header test may produce false positive due to mounted guard
- **Severity:** Major
- **Problem:** Header uses `mounted` state guard — jsdom may not reach `mounted=true` without `act()`, causing "menu item hidden" test to always pass regardless of env var.
- **Impact:** Test doesn't validate real behavior.
- **Recommended action:** Use `act(async () => {})` after render to trigger state update, then assert menu item visibility.

### [Major-5] No test coverage for NS_PRIVACY_POLICY group validity (merged with Major-2)
- **Severity:** Major
- **Problem:** New namespace group has no dedicated test for entry validity, duplicates, or membership.
- **Impact:** Regression undetectable.
- **Recommended action:** Add tests: entries belong to NAMESPACES, no duplicates, includes PrivacyPolicy.

### [Minor-3] Manual test for {date} parameter rendering
- **Severity:** Minor
- **Problem:** No automated test verifies `{date}` parameter is correctly passed (not rendered as literal `{date}`).
- **Impact:** Could pass Chrome Web Store review showing raw `{date}`.
- **Recommended action:** Add to manual testing checklist in Testing Strategy.
