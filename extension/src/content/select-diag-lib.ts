// The one console sink permitted under src/content/ (eslint.extension.config.mjs).
//
// The parameter type is deliberately NOT HTMLSelectElement. By the time a caller
// reaches here the card number and the address fields have already been written into
// the form, so an HTMLSelectElement would put `select.form.elements[*].value` — the
// PAN — one property access away inside the one file the lint gate exempts.
// SelectIdentity makes that a compile error instead of a review question.

export type SelectIdentity = { readonly name: string; readonly id: string };

/** Cap on the emitted label. `name`/`id` are page-controlled and unbounded. */
export const SELECT_DIAG_LABEL_MAX = 64;

const UNNAMED = "(unnamed)";

// Page-authored attributes may carry newlines, ANSI escapes and bidi controls. The
// log surfaces that matter here — CI console capture, telemetry pipelines, support
// bundles — are exactly the ones where those forge or obscure a `[passwd-sso]` line.
// \p{L} already excludes Cf and combining marks; it keeps `pref_東京都` readable,
// which an ASCII-only class would not.
const UNSAFE_LABEL_CHARS = /[^\p{L}\p{N}_\-.:[\]]/gu;

export function describeSelect(select: SelectIdentity): string {
  // Trimmed: a page-authored `name=" "` is truthy, so an untrimmed check would
  // short-circuit the id fallback and emit "?" — less useful than the sentinel.
  const raw = select.name.trim() || select.id.trim();
  if (!raw) return UNNAMED;

  const sanitized = raw.replace(UNSAFE_LABEL_CHARS, "?");

  // Code-point aware: String.prototype.slice would cut an astral character into a
  // lone surrogate, which JSON.stringify emits as unpaired \uD801 — invalid UTF-8
  // for a downstream log ingest.
  const points = [...sanitized];
  if (points.length <= SELECT_DIAG_LABEL_MAX) return sanitized;
  return points.slice(0, SELECT_DIAG_LABEL_MAX).join("") + "…";
}

export function logNoSelectMatch(select: SelectIdentity): void {
  if (typeof console !== "undefined" && console.debug) {
    console.debug(`[passwd-sso] No exact match for select: ${describeSelect(select)}`);
  }
}
