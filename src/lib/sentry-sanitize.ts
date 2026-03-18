// Regex patterns for sensitive data that must be scrubbed from error messages
const HEX64_RE = /[0-9a-fA-F]{64}/g;
// Base64: alphabet + padding, more than 40 chars
const BASE64_LONG_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

/**
 * Creates a sanitized copy of an error before sending to Sentry.
 * - Scrubs 64-char hex strings (encryption keys, hashes) from message and stack
 * - Scrubs long base64 strings (>40 chars) from message and stack
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
  sanitized.stack = err.stack ? scrubSensitivePatterns(err.stack) : err.stack;

  // Recursively sanitize cause chain
  if (err.cause !== undefined) {
    sanitized.cause = sanitizeErrorForSentry(err.cause);
  }

  return sanitized;
}

function scrubSensitivePatterns(message: string): string {
  return message
    .replace(HEX64_RE, "[redacted-key]")
    .replace(BASE64_LONG_RE, "[redacted-b64]");
}
