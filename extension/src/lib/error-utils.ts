const NETWORK_ERROR_PATTERN = /failed to fetch|networkerror|load failed/i;

// Codes this codebase throws deliberately (NO_TOKEN, PERMISSION_DENIED, …) are
// SCREAMING_SNAKE. Anything else is an incidental runtime message, and those are
// NOT safe to pass through: the return value of this function is delivered to the
// popup as a toast and, via the WebAuthn bridge, postMessage'd into the page's
// world. A JSON.parse over decrypted vault plaintext throws a SyntaxError whose
// message embeds a window of that plaintext — so an unconstrained Error -> string
// channel hands credential material to whatever is listening.
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Normalize an error into a stable, non-reflecting error code.
 *
 * Browser-specific fetch messages collapse to NETWORK_ERROR — Chrome ("Failed to
 * fetch"), Firefox ("NetworkError when attempting to fetch resource."), Safari
 * ("Load failed"). A deliberately-thrown code passes through. Everything else
 * becomes the caller's fallback, so no runtime message reaches a rendered or
 * cross-boundary surface.
 */
export function normalizeErrorCode(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : "";
  if (NETWORK_ERROR_PATTERN.test(raw)) {
    return "NETWORK_ERROR";
  }
  return ERROR_CODE_PATTERN.test(raw) ? raw : fallback;
}
