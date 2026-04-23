// Shared CSV utilities for audit log download routes

/** Column headers for audit log CSV exports. */
export const AUDIT_LOG_CSV_HEADERS = ["id", "action", "targetType", "targetId", "ip", "userAgent", "createdAt", "userId", "actorType", "userName", "userEmail", "metadata"] as const;

/**
 * Escapes a value for CSV output.
 * Prevents CSV injection by prefixing formula-triggering characters with a single quote.
 */
export function escapeCsvValue(v: string): string {
  const escaped = v.replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(escaped)) {
    return `"'${escaped}"`;
  }
  return `"${escaped}"`;
}

/** Formats an array of string values as a single CSV row. */
export function formatCsvRow(values: string[]): string {
  return values.map(escapeCsvValue).join(",");
}
