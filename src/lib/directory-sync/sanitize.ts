/**
 * Sanitize sync error messages before writing to the database.
 *
 * - Extracts Error.message (or stringifies unknown values)
 * - Strips URL query parameters (may contain tokens/secrets)
 * - Masks Bearer tokens, token= values, client_secret= values
 * - Truncates to 1 000 characters
 */

const MAX_LENGTH = 1_000;

/** Patterns that may leak credentials in error messages. */
const SENSITIVE_PATTERNS: [RegExp, string][] = [
  // Bearer tokens: "Bearer eyJ…" → "Bearer [REDACTED]"
  [/Bearer\s+\S+/gi, "Bearer [REDACTED]"],
  // Query/body param: token=xxx → token=[REDACTED]
  [/token=[^&\s"')]+/gi, "token=[REDACTED]"],
  // Query/body param: client_secret=xxx → client_secret=[REDACTED]
  [/client_secret=[^&\s"')]+/gi, "client_secret=[REDACTED]"],
];

/** Strip query parameters from any URLs found in the string. */
function stripQueryParams(input: string): string {
  // Match http(s) URLs and remove everything after '?'
  return input.replace(
    /https?:\/\/[^\s"')]+/gi,
    (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        // Not a valid URL — strip naively
        const qIdx = url.indexOf("?");
        return qIdx >= 0 ? url.slice(0, qIdx) : url;
      }
    },
  );
}

/**
 * Produce a safe, truncated error string suitable for DB storage.
 * Never throws — always returns a string.
 */
export function sanitizeSyncError(error: unknown): string {
  let message: string;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }

  // 1. Remove query params from URLs
  message = stripQueryParams(message);

  // 2. Mask sensitive patterns
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    message = message.replace(pattern, replacement);
  }

  // 3. Truncate
  if (message.length > MAX_LENGTH) {
    message = message.slice(0, MAX_LENGTH - 3) + "...";
  }

  return message;
}
