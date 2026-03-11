# Coding Deviation Log: extension-unlisted-distribution
Created: 2026-03-11T00:00:00+09:00

## Deviations from Plan

### DEV-1: Page component uses "use client" instead of server component
- **Plan description**: Server component with hardcoded lastUpdated date
- **Actual implementation**: Client component ("use client") with `useTranslations`
- **Reason**: All existing pages in the project use "use client" pattern. `useTranslations` works in both server and client, but keeping consistency with recovery/vault-reset pages is preferred. The page has no interactivity or state, so the difference is minimal.
- **Impact scope**: `src/app/[locale]/privacy-policy/page.tsx` only. No functional impact — content is still static.

---
