# Code Review: extension-unlisted-distribution
Date: 2026-03-11T00:00:00+09:00
Review round: 1 (final)

## Changes from Previous Round
Initial review

## Functionality Findings

No Critical or Major findings.

### [Minor-1] isValidStoreUrl lacks dedicated unit tests
- **File:** src/components/layout/header.test.tsx
- **Problem:** Only "URL not set" case is tested. Valid/invalid URL cases are not covered.
- **Resolution:** Skipped — CHROME_STORE_URL is a build-time constant, not mockable without module reload. E2E testing covers this.

### [Minor-2] LAST_UPDATED hardcoded in page component
- **File:** src/app/[locale]/privacy-policy/page.tsx:7
- **Problem:** Date is in source code rather than translation file.
- **Resolution:** Skipped — date is not a translation concern; code management is appropriate for a revision date.

## Security Findings

No findings. All security measures verified:
- URL whitelist validation with https:// prefix enforcement
- rel="noopener noreferrer" on external link
- Privacy policy layout excludes SessionProvider/VaultProvider
- Proxy only protects /dashboard; /privacy-policy is correctly public
- CSP and security headers applied to public pages via applySecurityHeaders

## Testing Findings

No Critical or Major findings.

### [Minor-3] Excluded set comment outdated
- **File:** src/i18n/namespace-groups.test.ts:39
- **Problem:** Comment listed 3 namespaces but 4 were excluded.
- **Resolution:** Fixed — comment updated to be generic.

### [Minor-4] APP_NAME test uses hardcoded string
- **File:** src/components/layout/header.test.tsx:108
- **Resolution:** Skipped — follows existing test conventions.

### [Minor-5] mounted guard not explicitly documented in tests
- **Resolution:** Skipped — jsdom executes useEffect synchronously; existing tests work correctly.

## Resolution Status

### [Minor-3] Comment mismatch in excluded set
- Action: Updated comment to "Page-specific namespaces intentionally excluded from NS_DASHBOARD_ALL"
- Modified file: src/i18n/namespace-groups.test.ts:39
