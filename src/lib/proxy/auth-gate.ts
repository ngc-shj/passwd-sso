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
  NEGATIVE_CACHE_TTL_MS,
  SESSION_CACHE_TTL_MS,
  type SessionInfo,
} from "@/lib/auth/session/session-cache";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { configuredSessionCookieName } from "@/lib/auth/session/cookie-name";
import {
  hasAnySessionCookie,
  readSessionCookie,
  SESSION_COOKIE_READ,
} from "@/lib/auth/session/session-cookie";
import { getLogger } from "@/lib/logger";

export type { SessionInfo } from "@/lib/auth/session/session-cache";
export { SESSION_CACHE_TTL_MS } from "@/lib/auth/session/session-cache";

/**
 * True iff the cookie header carries an Auth.js session token cookie.
 * Used by the CSRF gate to decide whether to run baseline Origin
 * enforcement (CSRF threat is cookie-based; without a cookie there's
 * nothing for an attacker to leverage in cross-site requests), and by the
 * Bearer-bypass decision in api-route.ts. Prefix-matched over every known
 * name, as Auth.js's SessionStore collects `<name>.0` chunks too: a narrower
 * check would let a chunk-named cookie take the Bearer bypass while `auth()`
 * authenticates it.
 */
export function hasSessionCookie(cookieHeader: string): boolean {
  return hasAnySessionCookie(cookieHeader);
}

export async function getSessionInfo(request: NextRequest): Promise<SessionInfo> {
  // Decide on the session Auth.js resolves from this same header, and
  // refuse any header it could read differently (see session-cookie.ts).
  // The cache used to be keyed on a different reading than the one the
  // session read forwarded, so a client could bind a key of its choosing to
  // session A and then present it alongside session B.
  const read = readSessionCookie(request.headers.get("cookie"));
  if (read.kind === SESSION_COOKIE_READ.AMBIGUOUS) {
    getLogger().warn({ msg: "auth-gate: ambiguous session cookie refused" });
    return { valid: false };
  }
  if (read.kind !== SESSION_COOKIE_READ.TOKEN) return { valid: false };
  const { token } = read;
  // Forward only the cookie that was decided on, in the one spelling it has.
  const cookie = `${configuredSessionCookieName()}=${token}`;

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
    // consumer never recombines a partial safe/unsafe mix, and marks it
    // degraded like auth.ts's own catch bundle: the state could not be read.
    let passkeyFields: Pick<
      SessionInfo,
      "hasPasskey" | "requirePasskey" | "requirePasskeyEnabledAt" | "passkeyGracePeriodDays"
    >;
    let passkeyStateDegraded = false;
    if (valid) {
      const missing = (
        ["hasPasskey", "requirePasskey", "requirePasskeyEnabledAt", "passkeyGracePeriodDays"] as const
      ).filter((field) => data?.user?.[field] === undefined);
      if (missing.length > 0) {
        // .error() not .warn(): this fires only when a fail-closed substitution
        // has already happened, and it is the sole signal that it did. An
        // operator setting LOG_LEVEL=error to cut noise would silence a warn
        // here and make a security-relevant degradation invisible.
        getLogger().error({
          msg: "auth-gate: session response missing passkey field(s), substituting fail-closed bundle",
          missing,
        });
        passkeyFields = {
          requirePasskey: true,
          hasPasskey: false,
          requirePasskeyEnabledAt: null,
          passkeyGracePeriodDays: null,
        };
        passkeyStateDegraded = true;
      } else {
        passkeyFields = {
          hasPasskey: data.user.hasPasskey,
          requirePasskey: data.user.requirePasskey,
          requirePasskeyEnabledAt: data.user.requirePasskeyEnabledAt,
          passkeyGracePeriodDays: data.user.passkeyGracePeriodDays,
        };
        passkeyStateDegraded = data.user.passkeyStateDegraded === true;
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
      passkeyStateDegraded,
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
    // A degraded bundle is cached only as long as a negative entry, so a
    // transient session-callback fault is re-read within seconds instead of
    // refusing the user for the positive TTL.
    if (passkeyStateDegraded) {
      ttlMs = Math.min(ttlMs, NEGATIVE_CACHE_TTL_MS);
    }
    await setCachedSession(token, info, ttlMs);
    return info;
  } catch {
    return { valid: false };
  }
}
