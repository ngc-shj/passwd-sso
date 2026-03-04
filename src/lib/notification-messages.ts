/**
 * Server-side notification message translations.
 *
 * next-intl's getTranslations() requires a request-scoped locale set via
 * setRequestLocale(), which is only available inside [locale] pages/layouts.
 * API routes and background jobs resolve locale manually via
 * resolveUserLocale(), so we keep a lightweight translation map here.
 */

const MESSAGES = {
  NEW_DEVICE_LOGIN: {
    ja: {
      title: "新しいデバイスからのログイン",
      body: (browser: string, os: string) =>
        `${browser} (${os}) からログインしました`,
    },
    en: {
      title: "New device login",
      body: (browser: string, os: string) =>
        `Signed in from ${browser} (${os})`,
    },
  },
  ADMIN_VAULT_RESET: {
    ja: {
      title: "保管庫リセットが開始されました",
      body: "テナント管理者があなたのアカウントの保管庫リセットを開始しました。",
    },
    en: {
      title: "Vault reset initiated",
      body: "A tenant admin has initiated a vault reset for your account.",
    },
  },
  ADMIN_VAULT_RESET_REVOKED: {
    ja: {
      title: "保管庫リセットが取り消されました",
      body: "テナント管理者がリセットを取り消しました。",
    },
    en: {
      title: "Vault reset cancelled",
      body: "A tenant admin has cancelled the vault reset.",
    },
  },
  WATCHTOWER_ALERT: {
    ja: {
      title: "Watchtower アラート",
      body: (count: string) =>
        `保管庫内で ${count} 件の新しいデータ漏洩が検出されました。`,
    },
    en: {
      title: "Watchtower alert",
      body: (count: string) =>
        `${count} new breach(es) detected in your vault.`,
    },
  },
} as const;

type MessageKey = keyof typeof MESSAGES;

function getLocaleMessages(key: MessageKey, locale: string) {
  const m = MESSAGES[key];
  return locale === "ja" ? m.ja : m.en;
}

export function notificationTitle(key: MessageKey, locale: string): string {
  const v = getLocaleMessages(key, locale).title;
  return typeof v === "function" ? (v as () => string)() : v;
}

export function notificationBody(
  key: MessageKey,
  locale: string,
  ...args: string[]
): string {
  const v = getLocaleMessages(key, locale).body;
  return typeof v === "function" ? (v as (...a: string[]) => string)(...args) : v;
}
