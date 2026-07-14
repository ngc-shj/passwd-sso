import { parse } from "tldts";

/**
 * Canonicalize a WebAuthn RP ID or page hostname as an ASCII domain name.
 * URL performs UTS #46/IDNA conversion for Unicode hostnames. Ports, paths,
 * credentials, IP literals, and malformed labels are never valid RP IDs.
 */
function canonicalDomain(value: string): string | null {
  if (!value || value !== value.trim()) return null;
  if (/[\\/@:?#\0]/.test(value)) return null;
  try {
    const hostname = new URL(`https://${value}`).hostname.toLowerCase();
    return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  } catch {
    return null;
  }
}

/**
 * Enforce the WebAuthn RP ID effective-domain rule at the trusted extension
 * boundary. Private PSL entries are enabled because multi-tenant hosts such as
 * github.io and appspot.com must not share passkeys across tenants.
 */
export function isRpIdAllowedForHostname(rpId: string, pageHostname: string): boolean {
  const rp = canonicalDomain(rpId);
  const hostname = canonicalDomain(pageHostname);
  if (!rp || !hostname) return false;

  const parsed = parse(rp, { allowPrivateDomains: true });
  if (parsed.isIp || parsed.domain === null) return false;

  return hostname === rp || hostname.endsWith(`.${rp}`);
}
