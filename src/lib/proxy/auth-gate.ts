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
      let resolved: string | null;
      try {
        resolved = await resolveUserTenantId(userId);
      } catch {
        // A THROW (DB/RLS error, MULTI_TENANT anomaly) must not be swallowed:
        // leaving tenantId undefined would drop the tenant's IP/CIDR gate for a
        // user who DOES have a restricted tenant. Fail closed (uncached) —
        // mirrors the !res.ok transient-error handling above.
        return { valid: false };
      }
      // A `null` return means NO active TenantMember row (deactivatedAt != null,
      // i.e. a de-provisioned member). `User.tenantId` is a non-null FK, so this
      // is NOT a legitimate "no tenant" user — it is a revoked membership whose
      // session must not survive. Fail closed so a stale cookie (or a session
      // whose deletion / cache invalidation was missed on deactivation) cannot
      // pass proxy session validation AND skip the tenant IP restriction
      // (undefined tenantId → the api-route/page-route gate is bypassed). This
      // is the session-path analogue of the extension-token C13 deactivated-
      // member rejection. The result is uncached (fail-closed sessions never
      // populate the cache).
      if (resolved === null) {
        return { valid: false };
      }
      tenantId = resolved;
    }

    // The session callback (src/auth.ts) always emits all four passkey fields
    // on BOTH its success and its fail-closed catch paths — under normal
    // operation these fields are always present when `valid` is true. If the
    // producer contract ever drifts (a field genuinely absent from the JSON),
    // per-field `?? false` / `?? null` defaults would be fragile: a partial
    // fallback set could land in "still in grace" and fail to block (see the
    // bundle-substitution comment in src/auth.ts's own catch path). Instead,
    // any missing field substitutes the ENTIRE fail-closed bundle so this
    // consumer never recombines a partial safe/unsafe mix. This only fires on
    // producer-contract drift and is positive-cached (valid: true) up to
    // session TTL by design — a sticky fail-closed block until TTL/invalidation,
    // mirroring what happens today when auth.ts's own catch bundle flows through.
    let passkeyFields: Pick<
      SessionInfo,
      "hasPasskey" | "requirePasskey" | "requirePasskeyEnabledAt" | "passkeyGracePeriodDays"
    >;
    if (valid) {
      const missing = (
        ["hasPasskey", "requirePasskey", "requirePasskeyEnabledAt", "passkeyGracePeriodDays"] as const
      ).filter((field) => data?.user?.[field] === undefined);
      if (missing.length > 0) {
        console.warn({
          msg: "auth-gate: session response missing passkey field(s), substituting fail-closed bundle",
          missing,
        });
        passkeyFields = {
          requirePasskey: true,
          hasPasskey: false,
          requirePasskeyEnabledAt: null,
          passkeyGracePeriodDays: null,
        };
      } else {
        passkeyFields = {
          hasPasskey: data.user.hasPasskey,
          requirePasskey: data.user.requirePasskey,
          requirePasskeyEnabledAt: data.user.requirePasskeyEnabledAt,
          passkeyGracePeriodDays: data.user.passkeyGracePeriodDays,
        };
      }
    } else {
      passkeyFields = {
        hasPasskey: data?.user?.hasPasskey ?? false,
        requirePasskey: data?.user?.requirePasskey ?? false,
        requirePasskeyEnabledAt: data?.user?.requirePasskeyEnabledAt ?? null,
        passkeyGracePeriodDays: data?.user?.passkeyGracePeriodDays ?? null,
      };
    }

    const info: SessionInfo = {
      valid,
      userId,
      tenantId,
      ...passkeyFields,
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
