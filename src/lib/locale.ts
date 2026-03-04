import { routing } from "@/i18n/routing";

/**
 * Resolve the user's preferred locale.
 *
 * Priority:
 *  1. Stored user preference (DB `User.locale`)
 *  2. Accept-Language header
 *  3. Fallback: "en"
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
    const jaIdx = lower.search(/\bja/);
    const enIdx = lower.search(/\ben/);
    if (jaIdx >= 0 && (enIdx < 0 || jaIdx < enIdx)) return "ja";
    return "en";
  }

  return "en";
}
