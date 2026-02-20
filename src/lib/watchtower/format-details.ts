import { formatDate } from "@/lib/format-datetime";

type Translator = (key: string, params: Record<string, string | number>) => string;

export function formatBreachDetails(details: string, t: Translator): string {
  const count = details.replace("count:", "");
  return t("breachedCount", { count });
}

export function formatWeakDetails(details: string, t: Translator): string {
  const entropy = details.replace("entropy:", "");
  return t("weakEntropy", { entropy });
}

export function formatOldDetails(details: string, t: Translator): string {
  const days = details.replace("days:", "");
  return t("oldDays", { days });
}

export function formatUnsecuredDetails(details: string): string {
  return details.replace("url:", "");
}

export function formatExpiringDetails(
  details: string,
  locale: string,
  t: Translator,
): string {
  if (details.startsWith("expired:")) {
    return t("expiredDays", { days: details.replace("expired:", "") });
  }
  return t("expiresOn", { date: formatDate(details.replace("expires:", ""), locale) });
}
