import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  AAL3_IDLE_TIMEOUT_MAX_MINUTES,
  AAL3_ABSOLUTE_TIMEOUT_MAX_MINUTES,
} from "@/lib/validations/common";

// Cache scaffold. 60s TTL matches the pattern used by the retired sessionDurationCache.
const SESSION_TIMEOUT_CACHE_TTL_MS = 60_000;
const SESSION_TIMEOUT_CACHE_MAX_SIZE = 10_000;

interface CacheEntry {
  idleMinutes: number;
  absoluteMinutes: number;
  tenantId: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Exported for tests only.
export const _internal = {
  cache,
  clear: () => cache.clear(),
};

export interface ResolvedSessionTimeouts {
  idleMinutes: number;
  absoluteMinutes: number;
  tenantId: string;
}

const WEBAUTHN_PROVIDER = "webauthn";

/**
 * Resolve the effective session idle + absolute timeouts for a user.
 *
 * Rule: `min(tenant, ...teams.filter(non-null))` for each axis. Team values
 * are constrained to `<= tenant value` on write, so this is equivalent to
 * "tenant value, with a stricter team override if any."
 *
 * AAL3 clamp: when `sessionProvider === "webauthn"`, the result is clamped
 * to NIST SP 800-63B §4.2.3 AAL3 ceilings regardless of policy values.
 *
 * Cache: per-userId, 60s TTL, bounded map. Invalidate on:
 *  - tenant policy PATCH via `invalidateSessionTimeoutCacheForTenant`
 *  - team policy PATCH via `invalidateSessionTimeoutCacheForTenant`
 *  - team membership change (add/remove member) via `invalidateSessionTimeoutCache`
 */
export async function resolveEffectiveSessionTimeouts(
  userId: string,
  sessionProvider: string | null,
): Promise<ResolvedSessionTimeouts> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return applyAal3Clamp(cached, sessionProvider);
  }
  if (cached) cache.delete(userId);

  // Fetch user's tenant policy + team policies in one round trip
  const user = await withBypassRls(
    prisma,
    async () =>
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          tenantId: true,
          tenant: {
            select: {
              sessionIdleTimeoutMinutes: true,
              sessionAbsoluteTimeoutMinutes: true,
            },
          },
          teamMemberships: {
            select: {
              team: {
                select: {
                  policy: {
                    select: {
                      sessionIdleTimeoutMinutes: true,
                      sessionAbsoluteTimeoutMinutes: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  if (!user) {
    // Defensive fallback — caller should have already validated userId.
    // Return restrictive defaults so a broken state does not keep sessions alive indefinitely.
    return {
      idleMinutes: 1,
      absoluteMinutes: 1,
      tenantId: "",
    };
  }

  let idleMinutes = user.tenant.sessionIdleTimeoutMinutes;
  let absoluteMinutes = user.tenant.sessionAbsoluteTimeoutMinutes;

  for (const m of user.teamMemberships) {
    const teamIdle = m.team.policy?.sessionIdleTimeoutMinutes;
    const teamAbs = m.team.policy?.sessionAbsoluteTimeoutMinutes;
    if (typeof teamIdle === "number" && teamIdle > 0) {
      idleMinutes = Math.min(idleMinutes, teamIdle);
    }
    if (typeof teamAbs === "number" && teamAbs > 0) {
      absoluteMinutes = Math.min(absoluteMinutes, teamAbs);
    }
  }

  const resolved: CacheEntry = {
    idleMinutes,
    absoluteMinutes,
    tenantId: user.tenantId,
    expiresAt: Date.now() + SESSION_TIMEOUT_CACHE_TTL_MS,
  };

  if (cache.size >= SESSION_TIMEOUT_CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, resolved);

  return applyAal3Clamp(resolved, sessionProvider);
}

function applyAal3Clamp(
  entry: { idleMinutes: number; absoluteMinutes: number; tenantId: string },
  sessionProvider: string | null,
): ResolvedSessionTimeouts {
  if (sessionProvider !== WEBAUTHN_PROVIDER) {
    return {
      idleMinutes: entry.idleMinutes,
      absoluteMinutes: entry.absoluteMinutes,
      tenantId: entry.tenantId,
    };
  }
  return {
    idleMinutes: Math.min(entry.idleMinutes, AAL3_IDLE_TIMEOUT_MAX_MINUTES),
    absoluteMinutes: Math.min(entry.absoluteMinutes, AAL3_ABSOLUTE_TIMEOUT_MAX_MINUTES),
    tenantId: entry.tenantId,
  };
}

/** Invalidate the cached resolved timeouts for a single user. */
export function invalidateSessionTimeoutCache(userId: string): void {
  cache.delete(userId);
}

/** Invalidate all cached entries whose tenantId matches. O(n) in cache size. */
export function invalidateSessionTimeoutCacheForTenant(tenantId: string): void {
  for (const [userId, entry] of cache) {
    if (entry.tenantId === tenantId) {
      cache.delete(userId);
    }
  }
}
