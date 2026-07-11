// Shared CSV formula-injection (CSV injection) neutralization.
//
// A cell whose value begins with one of `= + - @ \t \r` is interpreted as a
// formula by Excel / Google Sheets / LibreOffice when the exported file is
// opened, enabling data exfiltration (HYPERLINK / WEBSERVICE) or command
// execution (DDE). The fix is to prefix such a cell with a single quote so the
// spreadsheet treats it as literal text. This is CodeQL's js/incomplete-
// sanitization sibling and OWASP "CSV Injection".
//
// Leading whitespace (spaces, tabs, newlines) before the trigger char is also
// caught (`\s*` prefix) — spreadsheets still evaluate `  =1+1` as a formula,
// so a value with leading whitespace and a trigger char needs the same guard.
//
// SSoT for the trigger set so the audit-log exporter and the vault/team
// exporter cannot drift (they historically had two independent escapers, one
// of which lacked the guard entirely).

/** Characters that make a spreadsheet interpret a cell as a formula. */
export const CSV_FORMULA_TRIGGER_RE = /^\s*[=+\-@\t\r]/;

/**
 * Escapes a value for a compatibility CSV format that only quote-wraps cells
 * containing a delimiter/quote/newline (Bitwarden-compatible layout), while
 * still neutralizing formula-injection.
 *
 * RS6 ordering: the `"` → `""` doubling is decided and applied together with
 * the quote-wrap, and the formula prefix is added inside the quotes — a
 * formula-triggering cell is always quote-wrapped so the leading `'` cannot be
 * stripped by a bare unquoted value.
 */
export function escapeCsvCompat(val: string | null): string {
  if (!val) return "";
  const needsQuote =
    val.includes(",") ||
    val.includes('"') ||
    val.includes("\n") ||
    CSV_FORMULA_TRIGGER_RE.test(val);
  if (!needsQuote) return val;
  const escaped = val.replace(/"/g, '""');
  const prefixed = CSV_FORMULA_TRIGGER_RE.test(escaped) ? `'${escaped}` : escaped;
  return `"${prefixed}"`;
}
