// The one console sink permitted under src/background/ (eslint.extension.config.mjs).
//
// The exemption lands here rather than on index.ts because index.ts holds the vault
// key and every decrypted blob. Both parameters are closed unions, so there is no
// free-form slot a caller could fill with an Error message — the same contract
// src/lib/boot-stderr.ts has on the server side.

export type BackgroundWarnEvent =
  | "webauthn-interceptor-register-failed"
  | "copy-command-failed";

export type BackgroundErrorCode =
  | "dom-exception"
  | "type-error"
  | "syntax-error"
  | "error"
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

export function warnBackground(
  event: BackgroundWarnEvent,
  code: BackgroundErrorCode,
): void {
  console.warn(`[passwd-sso] ${event}: ${code}`);
}
