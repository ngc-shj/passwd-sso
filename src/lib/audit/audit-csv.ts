// Shared CSV utilities for audit log download routes

import { CSV_FORMULA_TRIGGER_RE } from "@/lib/format/csv-escape";

/** Column headers for audit log CSV exports. */
export const AUDIT_LOG_CSV_HEADERS = ["id", "action", "targetType", "targetId", "ip", "userAgent", "createdAt", "userId", "actorType", "userName", "userEmail", "metadata"] as const;

/**
 * Escapes a value for CSV output.
 * Prevents CSV injection by prefixing formula-triggering characters with a single quote.
 * Always quote-wraps (this export format is not size-constrained by compatibility).
 */
export function escapeCsvValue(v: string): string {
  // RS6: double the quote char FIRST, then decide on the formula prefix so the
  // prefix decision runs on the already-escaped string.
  const escaped = v.replace(/"/g, '""');
  if (CSV_FORMULA_TRIGGER_RE.test(escaped)) {
    return `"'${escaped}"`;
  }
  return `"${escaped}"`;
}

/** Formats an array of string values as a single CSV row. */
export function formatCsvRow(values: string[]): string {
  return values.map(escapeCsvValue).join(",");
}
