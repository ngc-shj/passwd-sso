import { routing } from "@/i18n/routing";

export type AppLocale = (typeof routing.locales)[number];

export function isAppLocale(value: string): value is AppLocale {
  return (routing.locales as readonly string[]).includes(value);
}

export function getLocaleFromPathname(pathname: string): AppLocale {
  const [, first] = pathname.split("/");
  return first && isAppLocale(first) ? first : routing.defaultLocale;
}

export function stripLocalePrefix(pathname: string): string {
  const segments = pathname.split("/");
  if (segments[1] && isAppLocale(segments[1])) {
    const rest = segments.slice(2).join("/");
    return rest ? `/${rest}` : "/";
  }
  return pathname;
}

export function detectBestLocaleFromAcceptLanguage(
  acceptLanguage: string | null
): AppLocale {
  if (!acceptLanguage) return routing.defaultLocale;

  const supported = routing.locales as readonly string[];
  const parts = acceptLanguage
    .split(",")
    .map((part) => part.split(";")[0]?.trim().toLowerCase())
    .filter(Boolean) as string[];

  for (const lang of parts) {
    if (supported.includes(lang)) return lang as AppLocale;
    const primary = lang.split("-")[0];
    if (primary && supported.includes(primary)) return primary as AppLocale;
  }
  return routing.defaultLocale;
}

