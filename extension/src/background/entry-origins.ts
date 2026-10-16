import { normalizeOrigin } from "../lib/http-auth-bindings";

/**
 * The origins a decrypted entry blob was saved for: its `url` and its
 * `url`-type custom fields (type compared case-insensitively), each normalized
 * by normalizeOrigin. A value that is not an http(s) URL is skipped. Unlike the
 * fill path's host lists, the scheme and port are kept, so an https-saved entry
 * never matches an http origin on the same host.
 */
export function savedUrlOrigins(blob: { url?: unknown; customFields?: unknown }): string[] {
  const customUrls = (Array.isArray(blob.customFields) ? blob.customFields : [])
    .filter(
      (f): f is { type: string; value?: unknown } =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as { type?: unknown }).type === "string" &&
        (f as { type: string }).type.toLowerCase() === "url",
    )
    .map((f) => f.value);
  const origins = [blob.url, ...customUrls]
    .map((value) => (typeof value === "string" ? normalizeOrigin(value) : null))
    .filter((origin): origin is string => origin !== null);
  return [...new Set(origins)];
}
