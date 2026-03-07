/**
 * Sensitive data scrubbing utility for Sentry events.
 *
 * Recursively strips values for keys matching sensitive patterns.
 * Used in Sentry's `beforeSend` hook to prevent leaking passwords,
 * encryption keys, tokens, and other secret data.
 */

const SENSITIVE_PATTERNS = [
  "password",
  "passphrase",
  "secret",
  "key",
  "token",
  "auth",
  "mnemonic",
  "seed",
  "private",
  "pepper",
  "verifier",
  "blob",
  "ciphertext",
  "encrypted",
] as const;

const REDACTED = "[Redacted]";

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Recursively scrub sensitive values from an object.
 * Returns a new object; does not mutate the input.
 */
export function scrubObject(obj: unknown, depth = 0): unknown {
  if (depth > 10) return REDACTED;

  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => scrubObject(item, depth + 1));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = scrubObject(value, depth + 1);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Sentry `beforeSend` hook that scrubs sensitive data from events.
 * Exported for use in sentry.client.config.ts and instrumentation.ts.
 */
export function scrubSentryEvent<T extends Record<string, unknown>>(event: T): T {
  // Scrub extra data
  if (event.extra && typeof event.extra === "object") {
    event.extra = scrubObject(event.extra) as typeof event.extra;
  }

  // Scrub contexts
  if (event.contexts && typeof event.contexts === "object") {
    event.contexts = scrubObject(event.contexts) as typeof event.contexts;
  }

  // Scrub breadcrumbs
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((bc: Record<string, unknown>) => {
      if (bc.data && typeof bc.data === "object") {
        return { ...bc, data: scrubObject(bc.data) };
      }
      return bc;
    }) as typeof event.breadcrumbs;
  }

  // Scrub request body
  const request = event.request as Record<string, unknown> | undefined;
  if (request?.data && typeof request.data === "object") {
    request.data = scrubObject(request.data);
  }

  return event;
}
