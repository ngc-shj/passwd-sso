import { routing } from "@/i18n/routing";

/**
 * Resolve the user's preferred locale.
 *
 * Priority:
 *  1. Stored user preference (DB `User.locale`)
 *  2. Accept-Language header
 *  3. routing.defaultLocale ("ja")
 */
export function resolveUserLocale(
  storedLocale?: string | null,
  acceptLanguage?: string | null,
): string {
  if (storedLocale && routing.locales.includes(storedLocale as "ja" | "en")) {
    return storedLocale;
  }

  if (acceptLanguage) {
    const lower = acceptLanguage.toLowerCase();
    const enIdx = lower.search(/\ben/);
    const jaIdx = lower.search(/\bja/);
    if (enIdx >= 0 && (jaIdx < 0 || enIdx < jaIdx)) return "en";
    return "ja";
  }

  return routing.defaultLocale;
}
