// Shared CSV formula-injection (CSV injection) neutralization for the CLI.
//
// Mirrors src/lib/format/csv-escape.ts byte-for-byte behavior. The CLI is a
// separate ESM package and cannot import the app module, so the trigger set
// and escape logic are duplicated here; the parity test in
// cli/src/__tests__/unit/csv-escape.test.ts pins them to the same cases as the
// app twin so the two implementations cannot drift silently.
//
// A cell whose value begins with one of `= + - @ \t \r` is interpreted as a
// formula by Excel / Google Sheets / LibreOffice when the exported file is
// opened, enabling data exfiltration (HYPERLINK / WEBSERVICE) or command
// execution (DDE). Prefixing such a cell with a single quote makes the
// spreadsheet treat it as literal text.
//
// Leading whitespace (spaces, tabs, newlines) before the trigger char is also
// caught (`\s*` prefix) — spreadsheets still evaluate `  =1+1` as a formula,
// so a value with leading whitespace and a trigger char needs the same guard.

/** Characters that make a spreadsheet interpret a cell as a formula. */
export const CSV_FORMULA_TRIGGER_RE = /^\s*[=+\-@\t\r]/;

/**
 * Escapes a value for a compatibility CSV format that only quote-wraps cells
 * containing a delimiter/quote/newline (Bitwarden-compatible layout), while
 * still neutralizing formula-injection.
 *
 * RS6 ordering: the `"` → `""` doubling is applied before the formula-prefix
 * decision, and the prefix is added inside the quotes — a formula-triggering
 * cell is always quote-wrapped so the leading `'` cannot be stripped by a bare
 * unquoted value.
 */
export function escapeCsvCompat(value: string): string {
  const needsQuote =
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    CSV_FORMULA_TRIGGER_RE.test(value);
  if (!needsQuote) return value;
  const escaped = value.replace(/"/g, '""');
  const prefixed = CSV_FORMULA_TRIGGER_RE.test(escaped) ? `'${escaped}` : escaped;
  return `"${prefixed}"`;
}
