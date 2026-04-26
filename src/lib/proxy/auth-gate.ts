/**
 * Session validation + in-process session cache for the proxy layer.
 *
 * Extracted from `src/proxy.ts` so the orchestrator stays thin.
 *
 * Cache trade-offs (preserved from previous location):
 *   - Multi-worker gap: each Node.js worker process holds an independent cache instance.
 *     Session revocation on one worker takes up to SESSION_CACHE_TTL_MS (30 s) to propagate
 *     to other workers. For single-process deployments this is not an issue.
 *   - Plaintext keys: the session token is stored as-is in process memory. A heap snapshot
 *     would expose tokens. Future improvement: migrate to a shared Redis cache with hashed keys.
 */

import type { NextRequest } from "next/server";
import { API_PATH } from "@/lib/constants";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { SESSION_CACHE_MAX } from "@/lib/validations/common.server";

export const SESSION_CACHE_TTL_MS = 30_000;

export interface SessionInfo {
  valid: boolean;
  userId?: string;
  tenantId?: string;
  hasPasskey?: boolean;
  requirePasskey?: boolean;
  requirePasskeyEnabledAt?: string | null;
  passkeyGracePeriodDays?: number | null;
}

export const sessionCache = new Map<string, { expiresAt: number } & SessionInfo>();

/**
 * Extract the Auth.js session token value from the cookie header.
 * Returns empty string if no known session token cookie is present.
 */
export function extractSessionToken(cookie: string): string {
  // Cookie names used by Auth.js (dev and prod variants)
  const names = ["__Secure-authjs.session-token", "authjs.session-token"];
  for (const name of names) {
    const prefix = `${name}=`;
    const idx = cookie.indexOf(prefix);
    if (idx !== -1) {
      const start = idx + prefix.length;
      const end = cookie.indexOf(";", start);
      return end === -1 ? cookie.slice(start) : cookie.slice(start, end);
    }
  }
  return "";
}

/**
 * True iff the cookie header carries an Auth.js session token cookie.
 * Used by the CSRF gate to decide whether to run baseline Origin
 * enforcement (CSRF threat is cookie-based; without a cookie there's
 * nothing for an attacker to leverage in cross-site requests).
 */
export function hasSessionCookie(cookieHeader: string): boolean {
  return extractSessionToken(cookieHeader) !== "";
}

export async function getSessionInfo(request: NextRequest): Promise<SessionInfo> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return { valid: false };

  const cacheKey = extractSessionToken(cookie);
  if (!cacheKey) return { valid: false };

  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      valid: cached.valid,
      userId: cached.userId,
      tenantId: cached.tenantId,
      hasPasskey: cached.hasPasskey,
      requirePasskey: cached.requirePasskey,
      requirePasskeyEnabledAt: cached.requirePasskeyEnabledAt,
      passkeyGracePeriodDays: cached.passkeyGracePeriodDays,
    };
  }
  if (cached) sessionCache.delete(cacheKey);

  try {
    const sessionUrl = new URL(
      `${request.nextUrl.basePath}${API_PATH.AUTH_SESSION}`,
      request.url,
    );
    const res = await fetch(sessionUrl, { headers: { cookie } });
    if (!res.ok) {
      // Non-200 from auth session endpoint is a transient server error,
      // not a definitive "session invalid" signal — do NOT cache.
      return { valid: false };
    }
    const data = await res.json();
    const valid = !!data?.user;
    const userId = data?.user?.id ?? undefined;

    let tenantId: string | undefined;
    if (valid && userId) {
      try {
        tenantId = (await resolveUserTenantId(userId)) ?? undefined;
      } catch {
        // Non-critical: tenant resolution failure should not block session validation
      }
    }

    const hasPasskey: boolean = data?.user?.hasPasskey ?? false;
    const requirePasskey: boolean = data?.user?.requirePasskey ?? false;
    const requirePasskeyEnabledAt: string | null = data?.user?.requirePasskeyEnabledAt ?? null;
    const passkeyGracePeriodDays: number | null = data?.user?.passkeyGracePeriodDays ?? null;

    const info: SessionInfo = {
      valid,
      userId,
      tenantId,
      hasPasskey,
      requirePasskey,
      requirePasskeyEnabledAt,
      passkeyGracePeriodDays,
    };
    setSessionCache(cacheKey, info);
    return info;
  } catch {
    return { valid: false };
  }
}

export function setSessionCache(key: string, info: SessionInfo) {
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    const now = Date.now();
    // First pass: evict all expired entries
    for (const [k, v] of sessionCache) {
      if (v.expiresAt <= now) sessionCache.delete(k);
    }
    // Second pass: if still at limit, evict the oldest entry (Map preserves insertion order)
    if (sessionCache.size >= SESSION_CACHE_MAX) {
      const oldest = sessionCache.keys().next().value;
      if (oldest !== undefined) sessionCache.delete(oldest);
    }
  }
  sessionCache.set(key, {
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    ...info,
  });
}
