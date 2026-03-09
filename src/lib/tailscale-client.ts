/**
 * Tailscale local API client for WhoIs peer verification.
 *
 * Calls the tailscaled local API to verify that a Tailscale IP belongs
 * to the expected tailnet. Results are cached for 30 seconds.
 */

import { isTailscaleIp, isValidIpAddress } from "@/lib/ip-access";

const TAILSCALE_API_BASE = "http://127.0.0.1:41112";
const WHOIS_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_SIZE = 500;

// ─── Cache ───────────────────────────────────────────────────

interface CacheEntry {
  tailnet: string | null; // null = not a valid tailscale peer
  expiresAt: number;
}

const whoIsCache = new Map<string, CacheEntry>();

function getCached(ip: string): CacheEntry | null {
  const entry = whoIsCache.get(ip);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    whoIsCache.delete(ip);
    return null;
  }
  return entry;
}

function setCache(ip: string, tailnet: string | null): void {
  // Evict oldest entries when at capacity
  if (whoIsCache.size >= CACHE_MAX_SIZE) {
    const firstKey = whoIsCache.keys().next().value;
    if (firstKey !== undefined) whoIsCache.delete(firstKey);
  }
  whoIsCache.set(ip, { tailnet, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── WhoIs response parsing ─────────────────────────────────

interface WhoIsResponse {
  Node?: {
    Name?: string; // FQDN like "hostname.tailnet-name.ts.net."
  };
}

/**
 * Extract the tailnet name from a Tailscale node FQDN.
 *
 * Node.Name is typically "hostname.tailnet-name.ts.net." (with trailing dot).
 * The tailnet name is the second-to-last segment before "ts.net.".
 */
function extractTailnetFromFqdn(fqdn: string): string | null {
  // Strip trailing dot and lowercase
  const normalized = fqdn.replace(/\.$/, "").toLowerCase();
  const parts = normalized.split(".");

  // Expected: hostname.tailnet-name.ts.net → ["hostname", "tailnet-name", "ts", "net"]
  if (parts.length < 4) return null;
  if (parts[parts.length - 1] !== "net" || parts[parts.length - 2] !== "ts")
    return null;

  return parts[parts.length - 3];
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Verify that a Tailscale IP belongs to the expected tailnet.
 *
 * Returns true if the peer is confirmed to be in the expected tailnet.
 * Returns false if:
 * - The IP is not in the Tailscale CGNAT range (100.64.0.0/10)
 * - The IP format is invalid
 * - tailscaled is unreachable or returns an error
 * - The peer belongs to a different tailnet
 */
export async function verifyTailscalePeer(
  ip: string,
  expectedTailnet: string,
): Promise<boolean> {
  // Quick check: not a Tailscale IP
  if (!isTailscaleIp(ip)) return false;

  // Validate IP format to prevent SSRF
  if (!isValidIpAddress(ip)) return false;

  // Check cache
  const cached = getCached(ip);
  if (cached) {
    if (!cached.tailnet) return false;
    return cached.tailnet === expectedTailnet.toLowerCase();
  }

  try {
    const url = new URL(
      `/localapi/v0/whois?addr=${encodeURIComponent(ip)}:0`,
      TAILSCALE_API_BASE,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WHOIS_TIMEOUT_MS);

    const res = await fetch(url.toString(), {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      setCache(ip, null);
      return false;
    }

    const data = (await res.json()) as WhoIsResponse;
    const nodeName = data?.Node?.Name;

    if (!nodeName) {
      setCache(ip, null);
      return false;
    }

    const tailnet = extractTailnetFromFqdn(nodeName);
    setCache(ip, tailnet);

    if (!tailnet) return false;
    return tailnet === expectedTailnet.toLowerCase();
  } catch {
    // Network error, timeout, invalid JSON, etc.
    setCache(ip, null);
    return false;
  }
}

// ─── Testing helpers ─────────────────────────────────────────

/** @internal Clear cache (for testing only) */
export function _clearWhoIsCache(): void {
  whoIsCache.clear();
}

/** @internal Exported for unit testing */
export { extractTailnetFromFqdn as _extractTailnetFromFqdn };
