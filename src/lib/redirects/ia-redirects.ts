import { routing } from "@/i18n/routing";

/**
 * IA migration redirect map for the personal-security-ia-redesign refactor.
 *
 * Each entry maps an old (pre-refactor) path to its new location. Paths are
 * locale-prefix-free; the prefix is added by `buildLocaleRedirects()` for
 * every supported locale at config time.
 *
 * Both prod (`next.config.ts`) and tests import this same module so they
 * share the source of truth.
 */
export const IA_REDIRECTS = [
  { from: "/dashboard/settings/security", to: "/dashboard/settings/account" },
  { from: "/dashboard/settings/security/sessions", to: "/dashboard/settings/devices" },
  { from: "/dashboard/settings/security/passkey", to: "/dashboard/settings/auth/passkey" },
  { from: "/dashboard/settings/security/travel-mode", to: "/dashboard/settings/vault/travel-mode" },
  { from: "/dashboard/settings/security/key-rotation", to: "/dashboard/settings/vault/key-rotation" },
  { from: "/dashboard/settings/mcp/connections", to: "/dashboard/settings/developer/mcp-connections" },
  { from: "/dashboard/settings/mcp/delegation", to: "/dashboard/settings/vault/delegation" },
] as const;

export type IaRedirect = (typeof IA_REDIRECTS)[number];

export type LocaleRedirect = {
  source: string;
  destination: string;
  permanent: true;
};

/**
 * Fan out `IA_REDIRECTS` over the configured locales. Each entry becomes one
 * Next.js `redirects()` rule per locale (308 permanent).
 */
export function buildLocaleRedirects(): LocaleRedirect[] {
  return IA_REDIRECTS.flatMap(({ from, to }) =>
    routing.locales.map((locale) => ({
      source: `/${locale}${from}`,
      destination: `/${locale}${to}`,
      permanent: true as const,
    })),
  );
}
