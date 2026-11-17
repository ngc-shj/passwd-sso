import { MS_PER_SECOND } from "@/lib/constants/time";

export function formatDateTime(value: string | Date, locale: string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString(locale);
}

export function formatDate(value: string | Date, locale: string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString(locale);
}

/**
 * Returns local date as "YYYY-MM-DD" string suitable for `<input type="date">`.
 * Unlike `toISOString().slice(0, 10)`, this uses local timezone to avoid
 * date shifts near midnight.
 */
export function toISODateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Parses a "YYYY-MM-DD" `<input type="date">` value as that calendar day in the
 * local timezone — the inverse of toISODateString. `new Date("YYYY-MM-DD")`
 * reads it as UTC midnight instead. With `endOfDay`, the day's last millisecond.
 * Undefined for anything that is not a real calendar date.
 */
export function parseLocalDate(value: string, endOfDay = false): Date | undefined {
  // Four or more year digits: what a date input can emit (HTML valid date string).
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  // setFullYear, not the Date(y, m, d) constructor, which maps years 0–99 to 1900–1999.
  const date = new Date(0);
  date.setFullYear(y, m, d);
  if (endOfDay) date.setHours(23, 59, 59, 999);
  else date.setHours(0, 0, 0, 0);
  // Date rolls an out-of-range day over (2026-02-30 → March 2), and a year past
  // the Date range is NaN; refuse both instead.
  return !Number.isNaN(date.getTime()) && date.getFullYear() === y && date.getMonth() === m && date.getDate() === d
    ? date
    : undefined;
}

export function formatRelativeTime(value: string | Date, locale: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / MS_PER_SECOND);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (diffSec < 60) return rtf.format(-diffSec, "second");
  if (diffMin < 60) return rtf.format(-diffMin, "minute");
  if (diffHour < 24) return rtf.format(-diffHour, "hour");
  if (diffDay < 30) return rtf.format(-diffDay, "day");

  return date.toLocaleDateString(locale);
}
