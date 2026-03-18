/**
 * Error-level sanitization for Sentry.
 *
 * Scrubs hex keys from Error.message and Error.stack, and base64 from
 * Error.message only (stack excluded to avoid mangling file paths).
 * Applied BEFORE passing to captureException(). Used in:
 *   - src/lib/with-request-log.ts (server-side catch block)
 *   - src/app/global-error.tsx (client-side error boundary)
 *   - src/instrumentation.ts (onRequestError hook)
 *
 * Complementary to src/lib/sentry-scrub.ts which scrubs Sentry EVENT
 * objects (extra, contexts, breadcrumbs) via the beforeSend hook.
 */

// Regex patterns for sensitive data that must be scrubbed from error messages
const HEX64_RE = /[0-9a-fA-F]{64}/g;
// Base64: full RFC 4648 alphabet + padding, more than 40 chars.
// Only applied to error messages (not stack traces) to avoid false positives on file paths.
const BASE64_LONG_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

/**
 * Creates a sanitized copy of an error before sending to Sentry.
 * - Scrubs 64-char hex strings (encryption keys, hashes) from message and stack
 * - Scrubs long base64 strings (>40 chars) from message only (stack: hex only)
 * - Recursively sanitizes the cause chain
 *
 * Note: Prisma meta fields are NOT copied because `new Error()` does not
 * inherit custom properties — they are absent by default.
 */
export function sanitizeErrorForSentry(err: unknown): Error {
  if (!(err instanceof Error)) {
    return new Error(String(err));
  }

  const sanitizedMessage = scrubSensitivePatterns(err.message);

  const sanitized = new Error(sanitizedMessage);
  sanitized.name = err.name;
  // Stack: only scrub hex keys, not base64 (to avoid mangling file paths)
  sanitized.stack = err.stack ? scrubHexOnly(err.stack) : err.stack;

  // Recursively sanitize cause chain
  if (err.cause !== undefined) {
    sanitized.cause = sanitizeErrorForSentry(err.cause);
  }

  return sanitized;
}

function scrubSensitivePatterns(text: string): string {
  return text
    .replace(HEX64_RE, "[redacted-key]")
    .replace(BASE64_LONG_RE, "[redacted-b64]");
}

function scrubHexOnly(text: string): string {
  return text.replace(HEX64_RE, "[redacted-key]");
}
