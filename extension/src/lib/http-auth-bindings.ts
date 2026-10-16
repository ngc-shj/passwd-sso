/**
 * The origin an http(s) URL belongs to, as `URL.origin` serializes it: scheme,
 * lowercased host (IDN in punycode, IPv6 in brackets) and the port only when it
 * is not the scheme's default. Credentials, path, query and fragment are
 * dropped. Null for anything that is not an http(s) URL with a host.
 */
export function normalizeOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.origin;
}
