/**
 * Locale constants — no next-intl dependency.
 *
 * This file is safe to import from `next.config.ts` and other contexts
 * where Next's TypeScript path-alias resolution does not follow transitive
 * imports. Both `src/i18n/routing.ts` (the next-intl routing definition)
 * and `src/lib/redirects/ia-redirects.ts` (consumed by `next.config.ts`)
 * depend on these constants.
 */
export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ja";
