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
import { ALL_KNOWN_SESSION_COOKIE_NAMES } from "@/lib/auth/session/cookie-name";

export type { SessionInfo } from "@/lib/auth/session/session-cache";
export { SESSION_CACHE_TTL_MS } from "@/lib/auth/session/session-cache";

/**
 * Extract the Auth.js session token value from the cookie header.
 * Returns empty string if no known session token cookie is present.
 * Walks ALL_KNOWN_SESSION_COOKIE_NAMES so any of the three current-issue
 * shapes (__Host- / __Secure- / plain) is recognized regardless of the
 * deployment's useSecureCookies + basePath combination.
 */
export function extractSessionToken(cookie: string): string {
  const segments = cookie.split(";");
  for (const name of ALL_KNOWN_SESSION_COOKIE_NAMES) {
    for (const segment of segments) {
      const trimmed = segment.trim();
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const cookieName = trimmed.slice(0, eqIdx);
      if (cookieName === name) {
        const raw = trimmed.slice(eqIdx + 1);
        // Auth.js cookie.parse wraps values in double quotes for some cookie
        // names; dequote so the session cache never aliases quoted/unquoted
        // variants of the same token (S5).
        if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
          return raw.slice(1, -1);
        }
        return raw;
      }
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
        // A `null` return is a legitimate no-active-membership user (no tenant
        // policy to enforce) → tenantId stays undefined, downstream IP gate is
        // correctly skipped. A THROW (DB/RLS error, MULTI_TENANT anomaly) is
        // NOT that case: swallowing it would drop the tenant's IP/CIDR gate for
        // a user who DOES have a restricted tenant. Fail closed by returning an
        // invalid (uncached) session, forcing re-auth — mirrors the !res.ok
        // transient-error handling above.
        tenantId = (await resolveUserTenantId(userId)) ?? undefined;
      } catch {
        return { valid: false };
      }
    }

    // The `?? false` / `?? null` defaults here are fail-open and are safe ONLY
    // because the session callback (src/auth.ts) always emits all four passkey
    // fields on BOTH its success and its fail-closed catch paths — so these
    // fallbacks only ever fire when the field is genuinely absent from the JSON
    // (never for a passkey-required tenant). If that callback contract ever
    // changes to omit a field, tighten these to a fail-closed default instead.
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
