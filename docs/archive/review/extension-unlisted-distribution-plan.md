# Plan: extension-unlisted-distribution

## Objective

Prepare the passwd-sso project for Chrome Web Store unlisted distribution of its browser extension. This includes:
1. A public `/privacy-policy` page within the app (required by Chrome Web Store)
2. A header menu item in the dashboard for users to install the extension
3. Store listing assets (description, permission justifications)

## Requirements

### Functional Requirements
- FR1: Public `/privacy-policy` page accessible without authentication, with i18n support (ja/en)
- FR2: Header dropdown menu item "Install Extension" that links to the Chrome Web Store unlisted URL
- FR3: Chrome Web Store listing description document (en) for submission reference
- FR4: Permission justification document for store submission

### Non-functional Requirements
- NFR1: Privacy policy page must follow existing routing patterns (next-intl, layout, namespace groups)
- NFR2: No changes to authentication or proxy logic — the page is public by default (not under `/dashboard`)
- NFR3: i18n translations for all new UI strings

## Technical Approach

### 1. Privacy Policy Page (`/[locale]/privacy-policy`)
- Follow the `recovery` page pattern: layout.tsx + page.tsx under `src/app/[locale]/privacy-policy/`
- Layout must only wrap `NextIntlClientProvider` — NOT `SessionProvider`/`VaultProvider` (public page, no auth context needed)
- Server component (static content, no client interactivity needed)
- New i18n namespace `PrivacyPolicy` with structured sections
- New namespace group `NS_PRIVACY_POLICY` in `namespace-groups.ts`
- Register namespace in `src/i18n/messages.ts`
- No proxy.ts changes needed — proxy only protects `/dashboard` routes and specific API paths; `/[locale]/privacy-policy` passes through the intl middleware without auth check
- `lastUpdated` date: hardcoded string in page component (e.g., "2026-03-11"), updated manually when policy is revised

### 2. Header Menu Item
- Add a `DropdownMenuItem` in `src/components/layout/header.tsx`
- Links to Chrome Web Store URL (configurable via environment variable `NEXT_PUBLIC_CHROME_STORE_URL`)
- **URL whitelist validation**: Only render link if URL starts with `https://chrome.google.com/webstore/` or `https://chromewebstore.google.com/` (prevents open redirect / injection)
- Falls back to hidden if env var is not set or fails validation
- Placed before the Sign Out separator
- Uses `Puzzle` icon from lucide-react
- Opens in new tab via `<a target="_blank" rel="noopener noreferrer">` (prevents reverse-tabnabbing)

### 3. Store Listing Assets
- `docs/extension-store-listing.md` — English store description, screenshots guidance, category
- Permission justifications included in the same document

## Implementation Steps

1. **Register i18n namespace**: Add `"PrivacyPolicy"` to `NAMESPACES` in `src/i18n/messages.ts` (MUST be first — translation files already exist and consistency test will fail without this)
2. **Verify/update translation files**: Check `messages/en/PrivacyPolicy.json` and `messages/ja/PrivacyPolicy.json` match plan structure
3. **Add namespace group**: Add `NS_PRIVACY_POLICY` to `src/i18n/namespace-groups.ts`
4. **Update namespace-groups.test.ts**: Add `"PrivacyPolicy"` to `excluded` set in `NS_DASHBOARD_ALL` coverage test; add dedicated tests for `NS_PRIVACY_POLICY` (entries in NAMESPACES, no duplicates, includes PrivacyPolicy)
5. **Create layout**: `src/app/[locale]/privacy-policy/layout.tsx` — follow recovery pattern, wrap only `NextIntlClientProvider` (no SessionProvider/VaultProvider)
6. **Create page**: `src/app/[locale]/privacy-policy/page.tsx` — server component with hardcoded `lastUpdated` date
7. **Add header menu translations**: Add `installExtension` key to `Dashboard` namespace (en/ja)
8. **Update header component**: Add extension install menu item with URL whitelist validation to `src/components/layout/header.tsx`
9. **Update header tests**: Add test for menu item rendering (with valid URL); add test for menu item hidden (no URL); use `act()` to ensure `mounted=true` state
10. **Add environment variable**: Add `NEXT_PUBLIC_CHROME_STORE_URL` to `.env.example`
11. **Create store listing document**: `docs/extension-store-listing.md` with description and permission justifications
12. **Run tests and build**: `npx vitest run` and `npx next build`

## Testing Strategy

- **Unit**: Existing header tests should not break; add test for new menu item rendering; add test verifying menu item is hidden when `NEXT_PUBLIC_CHROME_STORE_URL` is unset; use `act()` after render to ensure `mounted=true` state before asserting
- **Unit (namespace)**: Add tests for `NS_PRIVACY_POLICY` — entries belong to NAMESPACES, no duplicates, includes PrivacyPolicy; update `excluded` set in `NS_DASHBOARD_ALL` coverage test
- **i18n**: Verify both locales load without errors via build; both ja/en translation keys must exist (next-intl throws at build time if missing)
- **Integration**: `npx next build` confirms SSR works for the new page
- **Manual**: Navigate to `/ja/privacy-policy` and `/en/privacy-policy`; verify `lastUpdated` shows actual date (not `{date}` literal)

## Considerations & Constraints

- The Chrome Web Store URL is not yet known (account not yet registered). Use an env var so it can be set post-registration.
- Privacy policy content covers the extension only. If the app itself needs a separate policy later, it can be extended.
- The `PrivacyPolicy.json` translation files have already been created in a previous step. Verify they match the plan and adjust if needed.
- Store listing document is for reference during manual Chrome Web Store submission — not consumed by the app.
- The header menu item should be hidden when `NEXT_PUBLIC_CHROME_STORE_URL` is not configured or fails URL validation, to avoid showing a broken link.
