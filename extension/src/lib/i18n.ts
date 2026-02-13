import en from "../messages/en.json";
import ja from "../messages/ja.json";

type Locale = "en" | "ja";
type Messages = typeof en;

const MESSAGES: Record<Locale, Messages> = { en, ja };

function getLocale(): Locale {
  let raw: string | false = false;
  try {
    raw =
      typeof chrome !== "undefined" &&
      chrome.i18n &&
      typeof chrome.i18n.getUILanguage === "function" &&
      chrome.i18n.getUILanguage();
  } catch {
    // Extension context invalidated — fall through to navigator
  }
  if (!raw) {
    raw = typeof navigator !== "undefined" ? navigator.language : "en";
  }
  const normalized = (raw || "en").toLowerCase();
  return normalized.startsWith("ja") ? "ja" : "en";
}

function resolveMessage(path: string, locale: Locale): string | null {
  const parts = path.split(".");
  let current: unknown = MESSAGES[locale];
  for (const key of parts) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

export function t(
  path: string,
  params?: Record<string, string | number>
): string {
  const locale = getLocale();
  const fallback = resolveMessage(path, "en") ?? path;
  const message = resolveMessage(path, locale) ?? fallback;
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    return value === undefined ? `{${key}}` : String(value);
  });
}
