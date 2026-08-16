// The one console sink permitted under src/background/ (eslint.extension.config.mjs).
//
// The exemption lands here rather than on index.ts because index.ts holds the vault
// key and every decrypted blob. Both parameters are closed unions, so there is no
// free-form slot a caller could fill with an Error message — the same contract
// src/lib/boot-stderr.ts has on the server side.

export type BackgroundWarnEvent =
  | "webauthn-interceptor-register-failed"
  | "copy-command-failed"
  | "context-menu-create-failed";

export type BackgroundErrorCode =
  | "dom-exception"
  | "type-error"
  | "syntax-error"
  | "error"
  | "duplicate-id"
  | "orphan-parent"
  | "unknown";

/**
 * Classifies by the error's SHAPE, never its message or cause — a SyntaxError from
 * JSON.parse embeds a window of its input, which on the copy path is decrypted vault
 * plaintext.
 */
export function classifyError(err: unknown): BackgroundErrorCode {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return "dom-exception";
  }
  if (err instanceof SyntaxError) return "syntax-error";
  if (err instanceof TypeError) return "type-error";
  if (err instanceof Error) return "error";
  return "unknown";
}

/**
 * Classifies a chrome.runtime.lastError by matching its message against known
 * shapes and returning a closed-union code — the message itself never leaves
 * this module. classifyError cannot be used: lastError is `{ message?: string }`,
 * not an Error, so every input would fall through to "unknown".
 *
 * The distinction is load-bearing rather than cosmetic. A duplicate id means the
 * menu-rebuild serialization regressed; a missing parent means a child was created
 * against a parent that was never created. Collapsing both into one code would
 * leave the field-diagnosis path unable to tell a concurrency regression from an
 * ordering one.
 */
export function classifyLastError(
  err: { message?: string } | undefined,
): BackgroundErrorCode | null {
  if (!err) return null;
  const message = err.message;
  if (typeof message !== "string" || message === "") return "unknown";
  // Checked before orphan-parent: a duplicate id is the invariant the menu
  // serialization exists to protect, so it wins when a message matches both.
  if (message.includes("duplicate id")) return "duplicate-id";
  if (message.includes("Cannot find menu item with id")) return "orphan-parent";
  return "unknown";
}

export function warnBackground(
  event: BackgroundWarnEvent,
  code: BackgroundErrorCode,
): void {
  console.warn(`[passwd-sso] ${event}: ${code}`);
}
