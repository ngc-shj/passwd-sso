/**
 * IP address utilities for access restriction.
 *
 * - CIDR matching (IPv4 + IPv6)
 * - Client IP extraction with trusted proxy support (rightmost-untrusted)
 * - IPv4-mapped IPv6 normalization
 */

import type { NextRequest } from "next/server";
import { getLogger } from "@/lib/logger";

// ─── Trusted proxy configuration ─────────────────────────────

const DEFAULT_TRUSTED_PROXIES = "127.0.0.1/32,::1/128";

let trustedProxyCidrs: ParsedCidr[] | null = null;

function getTrustedProxies(): ParsedCidr[] {
  if (trustedProxyCidrs) return trustedProxyCidrs;
  const raw = process.env.TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES;
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  trustedProxyCidrs = [];
  for (const entry of entries) {
    const parsed = parseCidr(entry);
    if (parsed) {
      trustedProxyCidrs.push(parsed);
    } else {
      getLogger().warn({ entry }, "ip-access.trusted_proxies.invalid_entry_ignored");
    }
  }
  return trustedProxyCidrs;
}

// ─── CIDR parsing & matching ─────────────────────────────────

interface ParsedCidr {
  ip: number[];
  prefixLen: number;
  version: 4 | 6;
}

/**
 * Parse an IPv4 address into 4 octets.
 * Returns null if invalid.
 */
function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    // Reject leading zeros (e.g., "01", "001")
    if (part.length > 1 && part[0] === "0") return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Parse an IPv6 address into 16 bytes.
 * Handles :: expansion and IPv4-mapped addresses.
 * Returns null if invalid.
 */
function parseIpv6(ip: string): number[] | null {
  // Handle IPv4-mapped IPv6
  const v4MappedMatch = ip.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  );
  if (v4MappedMatch) {
    const v4 = parseIpv4(v4MappedMatch[1]);
    if (!v4) return null;
    // Represent as IPv4-mapped IPv6: 10 zero bytes + 0xff 0xff + 4 IPv4 bytes
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...v4];
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (!s) return [];
    const groups = s.split(":");
    const bytes: number[] = [];
    for (const g of groups) {
      if (g.length < 1 || g.length > 4) return null;
      const val = parseInt(g, 16);
      if (Number.isNaN(val) || val < 0 || val > 0xffff) return null;
      bytes.push((val >> 8) & 0xff, val & 0xff);
    }
    return bytes;
  };

  if (halves.length === 1) {
    const bytes = parseGroups(halves[0]);
    if (!bytes || bytes.length !== 16) return null;
    return bytes;
  }

  const left = parseGroups(halves[0]);
  const right = parseGroups(halves[1]);
  if (!left || !right) return null;

  const totalBytes = left.length + right.length;
  if (totalBytes > 16) return null;

  const padding = 16 - totalBytes;
  return [...left, ...new Array<number>(padding).fill(0), ...right];
}

/**
 * Normalize an IP address string.
 * Strips IPv4-mapped IPv6 prefix (::ffff:) and returns pure IPv4.
 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();

  // Strip IPv4-mapped IPv6 prefix
  const v4MappedMatch = trimmed.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  );
  if (v4MappedMatch) return v4MappedMatch[1];

  return trimmed;
}

/**
 * Convert an IP address to a rate limit key.
 * IPv6: use /64 prefix (first 4 groups) to prevent subnet rotation bypass.
 * IPv4: use full address.
 */
export function rateLimitKeyFromIp(ip: string): string {
  const normalized = normalizeIp(ip);
  if (!normalized.includes(":")) return normalized; // IPv4 passthrough

  // Expand abbreviated IPv6 and take first 4 groups (/64 prefix)
  const parts = normalized.split(":");
  // Handle :: expansion for abbreviated addresses
  if (normalized.includes("::")) {
    const sides = normalized.split("::");
    const left = sides[0] ? sides[0].split(":") : [];
    const right = sides[1] ? sides[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    const expanded = [...left, ...Array(missing).fill("0000"), ...right];
    return expanded.slice(0, 4).join(":") + "::/64";
  }
  return parts.slice(0, 4).join(":") + "::/64";
}

/**
 * Parse a CIDR notation string into a structured representation.
 * Returns null if the CIDR is invalid.
 */
function parseCidr(cidr: string): ParsedCidr | null {
  const parts = cidr.split("/");
  if (parts.length !== 2) return null;

  const prefixLen = Number(parts[1]);
  if (!Number.isInteger(prefixLen) || prefixLen < 0) return null;

  const ipStr = normalizeIp(parts[0]);

  // Try IPv4 first
  const v4 = parseIpv4(ipStr);
  if (v4) {
    if (prefixLen > 32) return null;
    // Verify network address matches prefix
    if (!isNetworkAddress(v4, prefixLen)) return null;
    return { ip: v4, prefixLen, version: 4 };
  }

  // Try IPv6
  const v6 = parseIpv6(parts[0]); // Use original for IPv6
  if (v6) {
    if (prefixLen > 128) return null;
    if (!isNetworkAddress(v6, prefixLen)) return null;
    return { ip: v6, prefixLen, version: 6 };
  }

  return null;
}

/** Check if the given IP bytes represent a valid network address for the prefix. */
function isNetworkAddress(ipBytes: number[], prefixLen: number): boolean {
  const totalBits = ipBytes.length * 8;
  for (let bit = prefixLen; bit < totalBits; bit++) {
    const byteIdx = Math.floor(bit / 8);
    const bitIdx = 7 - (bit % 8);
    if (ipBytes[byteIdx] & (1 << bitIdx)) return false;
  }
  return true;
}

/**
 * Check if an IP address is within a CIDR range.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const normalizedIp = normalizeIp(ip);
  const parsed = parseCidr(cidr);
  if (!parsed) return false;

  let ipBytes: number[] | null;
  if (parsed.version === 4) {
    ipBytes = parseIpv4(normalizedIp);
  } else {
    ipBytes = parseIpv6(ip); // Use original for IPv6
  }
  if (!ipBytes) return false;

  // Version mismatch
  if (parsed.version === 4 && ipBytes.length !== 4) return false;
  if (parsed.version === 6 && ipBytes.length !== 16) return false;

  return matchesPrefix(ipBytes, parsed.ip, parsed.prefixLen);
}

function matchesPrefix(
  ipBytes: number[],
  networkBytes: number[],
  prefixLen: number,
): boolean {
  const fullBytes = Math.floor(prefixLen / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== networkBytes[i]) return false;
  }
  const remainingBits = prefixLen % 8;
  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((ipBytes[fullBytes] & mask) !== (networkBytes[fullBytes] & mask))
      return false;
  }
  return true;
}

/**
 * Check if an IP matches a pre-parsed CIDR (avoids parse→format→re-parse round-trip).
 */
function isIpInParsedCidr(ip: string, parsed: ParsedCidr): boolean {
  const normalizedIp = normalizeIp(ip);
  let ipBytes: number[] | null;
  if (parsed.version === 4) {
    ipBytes = parseIpv4(normalizedIp);
  } else {
    ipBytes = parseIpv6(ip);
  }
  if (!ipBytes) return false;
  if (parsed.version === 4 && ipBytes.length !== 4) return false;
  if (parsed.version === 6 && ipBytes.length !== 16) return false;
  return matchesPrefix(ipBytes, parsed.ip, parsed.prefixLen);
}

/**
 * Check if an IP address is allowed by any of the given CIDRs.
 */
export function isIpAllowed(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  return cidrs.some((cidr) => isIpInCidr(ip, cidr));
}

/**
 * Validate a CIDR notation string strictly.
 * Network address must match the prefix (e.g., 192.168.1.1/24 is invalid).
 */
export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

// ─── Client IP extraction ────────────────────────────────────

/**
 * Extract the real client IP from a request using the rightmost-untrusted pattern.
 *
 * Walks X-Forwarded-For from right to left, stripping trusted proxy IPs.
 * Returns the first untrusted IP. If the direct connection is not from a
 * trusted proxy, X-Forwarded-For is ignored and the socket address is used.
 */
export function extractClientIp(request: NextRequest): string | null {
  // Next.js provides the socket IP via request.ip (may be undefined in some environments)
  const socketIp = (request as unknown as Record<string, unknown>).ip as
    | string
    | undefined;
  return extractClientIpFromHeaders(request.headers, socketIp);
}

/**
 * Header-only variant of extractClientIp for Server Components and contexts
 * without a NextRequest (e.g., `next/headers` in RSC, Request in generic handlers).
 * Same rightmost-untrusted algorithm as extractClientIp; socketIp is optional.
 */
export function extractClientIpFromHeaders(
  headers: Headers,
  socketIp?: string,
): string | null {
  const xff = headers.get("x-forwarded-for");
  const xRealIp = headers.get("x-real-ip");

  // If no forwarded headers, use socket IP or x-real-ip
  if (!xff) {
    const raw = socketIp ?? xRealIp ?? null;
    return raw ? normalizeIp(raw) : null;
  }

  // Check if the direct connection comes from a trusted proxy.
  // In many environments (Docker, reverse proxy), socketIp may be unavailable.
  // If socketIp is available and NOT trusted, ignore X-Forwarded-For.
  if (socketIp) {
    const normalizedSocket = normalizeIp(socketIp);
    const trusted = getTrustedProxies();
    const socketTrusted = trusted.some((cidr) =>
      isIpInParsedCidr(normalizedSocket, cidr),
    );
    if (!socketTrusted) {
      return normalizedSocket;
    }
  }

  // Rightmost-untrusted: walk from right to left
  const ips = xff.split(",").map((s) => normalizeIp(s));
  const trusted = getTrustedProxies();

  for (let i = ips.length - 1; i >= 0; i--) {
    const ip = ips[i];
    if (!ip) continue;

    const isTrusted = trusted.some((cidr) =>
      isIpInParsedCidr(ip, cidr),
    );

    if (!isTrusted) {
      return ip;
    }
  }

  // All IPs in XFF are trusted proxies — use the leftmost non-empty
  const leftmost = ips.find((ip) => ip.length > 0);
  return leftmost || socketIp || null;
}

function formatCidr(parsed: ParsedCidr): string {
  if (parsed.version === 4) {
    return `${parsed.ip.join(".")}/${parsed.prefixLen}`;
  }
  // Format IPv6 bytes back to colon notation
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((parsed.ip[i] << 8) | parsed.ip[i + 1]).toString(16));
  }
  return `${groups.join(":")}/${parsed.prefixLen}`;
}

// ─── Tailscale IP detection ──────────────────────────────────

const TAILSCALE_IPV4_CIDR = "100.64.0.0/10";
const TAILSCALE_IPV6_CIDR = "fd7a:115c:a1e0::/48";

/**
 * Check if an IP address is in a Tailscale range.
 * Tailscale assigns both IPv4 (100.64.0.0/10 CGNAT) and IPv6 (fd7a:115c:a1e0::/48 ULA).
 */
export function isTailscaleIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  return isIpInCidr(normalized, TAILSCALE_IPV4_CIDR) || isIpInCidr(normalized, TAILSCALE_IPV6_CIDR);
}

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6_SIMPLE_REGEX = /^[0-9a-fA-F:]+$/;

/**
 * Validate that an IP string is a well-formed IPv4 or IPv6 address.
 * Used to prevent SSRF in URL construction.
 */
export function isValidIpAddress(ip: string): boolean {
  if (IPV4_REGEX.test(ip)) {
    return parseIpv4(ip) !== null;
  }
  if (IPV6_SIMPLE_REGEX.test(ip)) {
    return parseIpv6(ip) !== null;
  }
  return false;
}

// ─── Reset for testing ───────────────────────────────────────

/** @internal Reset trusted proxy cache (for testing only) */
export function _resetTrustedProxyCache(): void {
  trustedProxyCidrs = null;
}
