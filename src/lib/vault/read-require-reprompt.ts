/**
 * Read the per-entry "ask for the master passphrase again before revealing or
 * copying this" flag out of an API response.
 *
 * Fail-closed on anything that is not a boolean. The flag decides whether a
 * decrypted secret may leave the vault without a fresh passphrase, so an absent
 * or off-type value must not be spelled the same as `false` — the team detail
 * builder used to drop the field entirely and every consumer coalesced the
 * absence to "no prompt required", which disabled the control for an entire
 * vault kind.
 *
 * Denying by prompting rather than by throwing is deliberate: a prompt is
 * recoverable in one step, whereas a throw here takes down the whole detail
 * pane for a flag the user can satisfy.
 */
export function readRequireReprompt(raw: unknown, fallback?: unknown): boolean {
  if (typeof raw === "object" && raw !== null) {
    const value = (raw as Record<string, unknown>).requireReprompt;
    if (typeof value === "boolean") return value;
  }
  // The personal path also carries the flag on the already-decrypted overview
  // row, which is a real second source rather than a guess — prefer it over the
  // fail-closed default so a response that omits the field does not start
  // prompting for entries the user never marked.
  if (typeof fallback === "boolean") return fallback;
  return true;
}
