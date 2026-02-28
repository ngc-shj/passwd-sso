import { hasLocale } from "next-intl";
import { routing } from "./routing";

/**
 * Authoritative list of every i18n namespace.
 * Each entry must correspond to a file `messages/{locale}/{Namespace}.json`.
 *
 * When adding a new namespace:
 *  1. Create `messages/en/MyNs.json` and `messages/ja/MyNs.json`
 *  2. Add `"MyNs"` to this array
 *  3. Add it to the appropriate group in `namespace-groups.ts`
 */
export const NAMESPACES = [
  "Metadata",
  "Common",
  "Auth",
  "Dashboard",
  "ShareLinks",
  "PasswordList",
  "Trash",
  "PasswordForm",
  "SecureNoteForm",
  "CreditCardForm",
  "PasskeyForm",
  "IdentityForm",
  "BankAccountForm",
  "SoftwareLicenseForm",
  "PasswordDetail",
  "RepromptDialog",
  "PasswordGenerator",
  "PasswordCard",
  "CopyButton",
  "SearchBar",
  "NotFound",
  "Error",
  "LanguageSwitcher",
  "Vault",
  "Recovery",
  "VaultReset",
  "Tag",
  "Import",
  "Export",
  "Watchtower",
  "TOTP",
  "Shortcuts",
  "Team",
  "AuditLog",
  "Share",
  "EmergencyAccess",
  "Extension",
  "ApiErrors",
  "Attachments",
  "Sessions",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

const validNamespaces: ReadonlySet<string> = new Set(NAMESPACES);

/**
 * Sanitise the locale value, falling back to the default locale when the
 * incoming value is not in the configured allowlist.
 */
function safeLocale(locale: string): string {
  return hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
}

/** Load all namespace files for the given locale and merge them. */
export async function loadAllMessages(locale: string) {
  const safe = safeLocale(locale);
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => {
      const mod = await import(`../../messages/${safe}/${ns}.json`);
      return [ns, mod.default] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/** Load only the specified namespaces for the given locale. */
export async function loadNamespaces(
  locale: string,
  namespaces: readonly string[],
) {
  const safe = safeLocale(locale);
  const entries = await Promise.all(
    namespaces.map(async (ns) => {
      if (!validNamespaces.has(ns)) {
        throw new Error(`[i18n] Invalid namespace: ${ns}`);
      }
      const mod = await import(`../../messages/${safe}/${ns}.json`);
      return [ns, mod.default] as const;
    }),
  );
  return Object.fromEntries(entries);
}
