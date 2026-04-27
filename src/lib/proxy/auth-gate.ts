/**
 * Session validation + Redis-backed session cache for the proxy layer.
 *
 * Backed by `@/lib/auth/session/session-cache` (HMAC-keyed Redis cache
 * with tombstone-based revocation, populate-after-invalidate guard, and
 * Zod-validated cache values). Per-worker in-process Map removed in the
 * sessioncache-redesign refactor — see docs/archive/review/sessioncache-
 * redesign-plan.md.
 */

import type { NextRequest } from "next/server";
import { API_PATH } from "@/lib/constants";
import {
  getCachedSession,
  setCachedSession,
  SESSION_CACHE_TTL_MS,
  type SessionInfo,
} from "@/lib/auth/session/session-cache";
import { resolveUserTenantId } from "@/lib/tenant-context";

export type { SessionInfo } from "@/lib/auth/session/session-cache";
export { SESSION_CACHE_TTL_MS } from "@/lib/auth/session/session-cache";

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

  const token = extractSessionToken(cookie);
  if (!token) return { valid: false };

  const cached = await getCachedSession(token);
  if (cached) return cached;

  // Cache miss → fetch /api/auth/session and populate.
  try {
    const sessionUrl = new URL(
      `${request.nextUrl.basePath}${API_PATH.AUTH_SESSION}`,
      request.url,
    );
    const res = await fetch(sessionUrl, { headers: { cookie } });
    if (!res.ok) {
      // Transient error — return invalid without caching.
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

    const info: SessionInfo = {
      valid,
      userId,
      tenantId,
      hasPasskey: data?.user?.hasPasskey ?? false,
      requirePasskey: data?.user?.requirePasskey ?? false,
      requirePasskeyEnabledAt: data?.user?.requirePasskeyEnabledAt ?? null,
      passkeyGracePeriodDays: data?.user?.passkeyGracePeriodDays ?? null,
    };

    // Derive ttlMs from data.expires (ISO 8601). Clamp downward only;
    // setCachedSession applies the floor (<1s → no cache) and ceiling
    // (SESSION_CACHE_TTL_MS) and handles negative-cache routing for
    // valid:false. We pass SESSION_CACHE_TTL_MS as the upper-bound ceiling
    // when expires is missing or unparsable.
    let ttlMs = SESSION_CACHE_TTL_MS;
    if (typeof data?.expires === "string") {
      const expiresMs = Date.parse(data.expires);
      if (Number.isFinite(expiresMs)) {
        ttlMs = expiresMs - Date.now();
      }
    }
    await setCachedSession(token, info, ttlMs);
    return info;
  } catch {
    return { valid: false };
  }
}
