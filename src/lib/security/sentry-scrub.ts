/**
 * Event-level scrubbing for Sentry.
 *
 * Recursively strips values for keys matching sensitive patterns
 * from Sentry EVENT objects (extra, contexts, breadcrumbs, request body,
 * spans). Also sanitizes URLs to remove query strings, fragments, and
 * capability path segments.
 * Used in Sentry's `beforeSend` and `beforeSendTransaction` hooks.
 *
 * Complementary to src/lib/sentry-sanitize.ts which scrubs Error.message
 * and Error.stack BEFORE passing to captureException().
 */

/**
 * Token-carrying route patterns whose path segments must be redacted.
 * Each entry: [pattern, replacement]. Non-anchored so locale prefixes
 * like /ja/... or /en/... match transparently.
 * Extend this list when adding new capability routes.
 */
export const TOKEN_ROUTE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Share/Send short links: /s/<token>
  // [^\s/?#:]+ rather than [^/?#]+ so the pattern works correctly in
  // free-text fields (exception.value, event.message) where a URL path
  // segment may be followed by a space or a colon (e.g. ": 403 Forbidden")
  // rather than only /?#.
  [/\/s\/[^\s/?#:]+/g, "/s/[redacted]"],
  // Team invite: /dashboard/teams/invite/<token>
  [/\/dashboard\/teams\/invite\/[^\s/?#:]+/g, "/dashboard/teams/invite/[redacted]"],
  // Emergency-access invite: /dashboard/emergency-access/invite/<token>
  [/\/dashboard\/emergency-access\/invite\/[^\s/?#:]+/g, "/dashboard/emergency-access/invite/[redacted]"],
];

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
 * Apply TOKEN_ROUTE_PATTERNS replacements to a free-text string.
 * Unlike sanitizeUrl, this does NOT strip ?/# — those are meaningful
 * in free-form messages (e.g. fetch-failure strings).
 */
export function redactCapabilityPaths(s: string): string {
  let result = s;
  for (const [pattern, replacement] of TOKEN_ROUTE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
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
 * Strip query strings, fragments, and capability path segments from a URL string.
 * Returns the sanitized URL, or the original value if it does not look like a URL.
 */
export function sanitizeUrl(value: string): string {
  let result = value;

  // Strip fragment first (fragments are not sent by the server but the
  // browser-side Sentry SDK captures window.location.href which includes them)
  const fragIdx = result.indexOf("#");
  if (fragIdx !== -1) result = result.slice(0, fragIdx);

  // Strip query string
  const qIdx = result.indexOf("?");
  if (qIdx !== -1) result = result.slice(0, qIdx);

  // Redact capability path segments
  result = redactCapabilityPaths(result);

  return result;
}

const URL_KEY_NAMES = new Set(["url", "http.url", "url.full", "http.target"]);
// url.query and url.path values are bare path/query strings — wipe entirely like request.query_string
const URL_WIPE_KEY_NAMES = new Set(["url.query", "url.path"]);

/**
 * Sentry `beforeSend` / `beforeSendTransaction` hook that scrubs sensitive data from events.
 * Exported for use in sentry.client.config.ts and sentry.server.config.ts.
 */
export function scrubSentryEvent<T extends Record<string, unknown>>(event: T): T {
  const e = event as Record<string, unknown>;

  // Scrub extra data
  if (e.extra && typeof e.extra === "object") {
    e.extra = scrubObject(e.extra);
  }

  // Scrub contexts — general key-based scrub, then apply URL sanitization to trace.data
  if (e.contexts && typeof e.contexts === "object") {
    e.contexts = scrubObject(e.contexts);
    const contexts = e.contexts as Record<string, unknown>;
    if (contexts.trace && typeof contexts.trace === "object") {
      const trace = contexts.trace as Record<string, unknown>;
      if (trace.data && typeof trace.data === "object") {
        const traceData = trace.data as Record<string, unknown>;
        const scrubbed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(traceData)) {
          if (isSensitiveKey(key)) {
            scrubbed[key] = REDACTED;
          } else if (URL_KEY_NAMES.has(key) && typeof value === "string") {
            scrubbed[key] = sanitizeUrl(value as string);
          } else if (URL_WIPE_KEY_NAMES.has(key)) {
            scrubbed[key] = "";
          } else {
            scrubbed[key] = scrubObject(value);
          }
        }
        trace.data = scrubbed;
      }
      // Redact capability paths from root-span description (free-text span name)
      if (typeof trace.description === "string") {
        trace.description = redactCapabilityPaths(trace.description);
      }
    }
  }

  // Scrub breadcrumbs — Sentry uses { values: BreadcrumbItem[] } format.
  // Also sanitize navigation breadcrumb from/to URLs.
  if (e.breadcrumbs && typeof e.breadcrumbs === "object") {
    const bcs = e.breadcrumbs as { values?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const items = Array.isArray(bcs) ? bcs : bcs.values;
    if (Array.isArray(items)) {
      const scrubbed = items.map((bc) => {
        let updated = bc;
        if (bc.data && typeof bc.data === "object") {
          updated = { ...updated, data: scrubObject(bc.data) };
        }
        // Apply sanitizeUrl to any data.url string (all categories)
        const currentData = updated.data as Record<string, unknown> | undefined;
        if (currentData && typeof currentData.url === "string") {
          updated = { ...updated, data: { ...currentData, url: sanitizeUrl(currentData.url) } };
        }
        // Sanitize navigation breadcrumb from/to — base on already-scrubbed data
        if (bc.category === "navigation") {
          const navData = (updated.data ?? {}) as Record<string, unknown>;
          const sanitizedNav: Record<string, unknown> = { ...navData };
          if (typeof navData.from === "string") sanitizedNav.from = sanitizeUrl(navData.from);
          if (typeof navData.to === "string") sanitizedNav.to = sanitizeUrl(navData.to);
          updated = { ...updated, data: sanitizedNav };
        }
        return updated;
      });
      if (Array.isArray(bcs)) {
        e.breadcrumbs = scrubbed;
      } else {
        bcs.values = scrubbed;
      }
    }
  }

  // Sanitize request.url and request.query_string
  const request = e.request as Record<string, unknown> | undefined;
  if (request) {
    if (typeof request.url === "string") {
      request.url = sanitizeUrl(request.url);
    }
    if (typeof request.query_string === "string" && request.query_string.length > 0) {
      // Strip the entire query string — it may carry token params
      request.query_string = "";
    }
    // Sanitize Referer header if present — may contain capability path tokens
    if (request.headers && typeof request.headers === "object") {
      const headers = request.headers as Record<string, unknown>;
      for (const key of ["Referer", "referer"]) {
        if (typeof headers[key] === "string") {
          headers[key] = sanitizeUrl(headers[key] as string);
        }
      }
    }
  }

  // Scrub request body (may be object or serialized JSON string)
  if (request?.data) {
    if (typeof request.data === "object") {
      request.data = scrubObject(request.data);
    } else if (typeof request.data === "string") {
      try {
        const parsed = JSON.parse(request.data);
        request.data = JSON.stringify(scrubObject(parsed));
      } catch {
        request.data = REDACTED;
      }
    }
  }

  // Scrub exception stack local variables and redact capability paths in value strings
  if (Array.isArray(e.exception)) {
    for (const frame of e.exception as Array<Record<string, unknown>>) {
      if (frame.values && Array.isArray(frame.values)) {
        for (const v of frame.values as Array<Record<string, unknown>>) {
          if (v.stacktrace && typeof v.stacktrace === "object") {
            v.stacktrace = scrubObject(v.stacktrace);
          }
          // Redact capability URLs embedded in exception message text
          if (typeof v.value === "string") {
            v.value = redactCapabilityPaths(v.value);
          }
        }
      }
    }
  } else if (e.exception && typeof e.exception === "object") {
    const exc = e.exception as Record<string, unknown>;
    if (Array.isArray(exc.values)) {
      for (const v of exc.values as Array<Record<string, unknown>>) {
        if (v.stacktrace && typeof v.stacktrace === "object") {
          v.stacktrace = scrubObject(v.stacktrace);
        }
        // Redact capability URLs embedded in exception message text
        if (typeof v.value === "string") {
          v.value = redactCapabilityPaths(v.value);
        }
      }
    }
  }

  // Redact capability URLs embedded in top-level event message text
  if (typeof e.message === "string") {
    e.message = redactCapabilityPaths(e.message);
  }

  // Scrub spans (transaction events) — each span's data object through key-based scrubObject,
  // and URL-named keys through sanitizeUrl
  if (Array.isArray(e.spans)) {
    for (const span of e.spans as Array<Record<string, unknown>>) {
      if (span.data && typeof span.data === "object") {
        const spanData = span.data as Record<string, unknown>;
        const scrubbed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(spanData)) {
          if (isSensitiveKey(key)) {
            scrubbed[key] = REDACTED;
          } else if (URL_KEY_NAMES.has(key) && typeof value === "string") {
            scrubbed[key] = sanitizeUrl(value);
          } else if (URL_WIPE_KEY_NAMES.has(key)) {
            scrubbed[key] = "";
          } else {
            scrubbed[key] = scrubObject(value);
          }
        }
        span.data = scrubbed;
      }
      // Redact capability paths from span description (free-text span name)
      if (typeof span.description === "string") {
        span.description = redactCapabilityPaths(span.description);
      }
    }
  }

  // Redact capability paths from top-level transaction name
  if (typeof e.transaction === "string") {
    e.transaction = redactCapabilityPaths(e.transaction);
  }

  // Redact capability paths from tags — Sentry auto-copies transaction into tags.transaction,
  // and custom tags could carry capability URLs.
  if (e.tags && typeof e.tags === "object" && !Array.isArray(e.tags)) {
    const tags = e.tags as Record<string, unknown>;
    for (const key of Object.keys(tags)) {
      if (typeof tags[key] === "string") {
        tags[key] = redactCapabilityPaths(tags[key] as string);
      }
    }
  }

  return event;
}
