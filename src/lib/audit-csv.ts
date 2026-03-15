// Shared CSV utilities for audit log download routes

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
