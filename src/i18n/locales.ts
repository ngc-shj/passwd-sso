/**
 * Locale constants — no next-intl dependency.
 *
 * Kept independent of `next-intl` so callers in non-Next-intl contexts
 * (build config, server-side tooling, tests) can import the canonical
 * locale list without pulling the runtime in.
 */
export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ja";
