import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { invalidateCachedSessionsBulk } from "@/lib/auth/session/session-cache";

/**
 * Options for {@link invalidateUserSessions}.
 *
 * Discriminated union — `tenantId` and `allTenants: true` are mutually
 * exclusive at compile time (F18 + F20). Pass `tenantId` for the standard
 * tenant-scoped invalidation (team removal, SCIM deletion). Pass
 * `allTenants: true` only for cross-tenant flows like admin vault reset,
 * where the target user's Session rows in OTHER tenants are still
 * authentication artifacts that survive the wipe (F3+S2).
 */
export type InvalidateUserSessionsOptions =
  | { tenantId: string; allTenants?: undefined; reason?: string }
  | { allTenants: true; tenantId?: undefined; reason?: string };

/**
 * Result of {@link invalidateUserSessions}. Counts revoked artifacts per
 * model so callers can record them in audit metadata.
 *
 * `cacheTombstoneFailures` is the number of session tokens whose Redis
 * tombstone write did NOT land. The DB-side delete is durable (Postgres
 * transaction); a tombstone failure means the cached SessionInfo can
 * survive on workers until SESSION_CACHE_TTL_MS expires, so a captured
 * session token may still authenticate from cache during that window.
 * Callers MUST include this in audit metadata so silent Redis outages
 * during a vault reset / member removal are forensically visible.
 */
export type InvalidateUserSessionsResult = {
  sessions: number;
  extensionTokens: number;
  apiKeys: number;
  mcpAccessTokens: number;
  mcpRefreshTokens: number;
  delegationSessions: number;
  cacheTombstoneFailures: number;
};

/**
 * Invalidate all sessions and tokens for a user.
 * Called on: team member removal, SCIM user deletion/deactivation,
 * and admin vault reset (cross-tenant via `allTenants: true`).
 *
 * Covers every user-bound auth artifact:
 *   - Session (DB row delete + cache tombstone)
 *   - ExtensionToken / ApiKey (revokedAt set)
 *   - McpAccessToken / McpRefreshToken / DelegationSession (revokedAt set)
 *
 * Why MCP tokens are included: a user who minted `mcp_*` tokens for AI
 * agents holds tokens that authenticate AS that user with credentials:list /
 * credentials:use scope. After a vault reset (or member removal) these
 * tokens must die — otherwise an attacker holding the token could re-attack
 * the freshly-set-up vault. WebAuthnCredential is intentionally NOT
 * revoked — it is the user's re-authentication path back into a fresh
 * vault setup.
 *
 * Uses withBypassRls() scoped to the target userId WHERE clause.
 */
export async function invalidateUserSessions(
  userId: string,
  options: InvalidateUserSessionsOptions,
): Promise<InvalidateUserSessionsResult> {
  // Defense-in-depth: discriminated union prevents this at compile time,
  // but a runtime cast (`as any`) could still leak both options through.
  if (options.tenantId && options.allTenants) {
    throw new Error(
      "invalidateUserSessions: tenantId and allTenants are mutually exclusive",
    );
  }

  const allTenants = "allTenants" in options && options.allTenants === true;
  const tenantFilter = allTenants ? {} : { tenantId: options.tenantId };
  const now = new Date();

  return withBypassRls(prisma, async () => {
    // SELECT tokens before deleteMany so we can invalidate the cache after
    // the DB delete commits (R3 / S-6 sequencing).
    const targetSessions = await prisma.session.findMany({
      where: { userId, ...tenantFilter },
      select: { sessionToken: true },
    });

    const [
      sessionsResult,
      extensionTokensResult,
      apiKeysResult,
      mcpAccessTokensResult,
      mcpRefreshTokensResult,
      delegationSessionsResult,
    ] = await Promise.all([
      prisma.session.deleteMany({
        where: { userId, ...tenantFilter },
      }),
      prisma.extensionToken.updateMany({
        where: { userId, revokedAt: null, ...tenantFilter },
        data: { revokedAt: now },
      }),
      prisma.apiKey.updateMany({
        where: { userId, revokedAt: null, ...tenantFilter },
        data: { revokedAt: now },
      }),
      prisma.mcpAccessToken.updateMany({
        where: { userId, revokedAt: null, ...tenantFilter },
        data: { revokedAt: now },
      }),
      prisma.mcpRefreshToken.updateMany({
        where: { userId, revokedAt: null, ...tenantFilter },
        data: { revokedAt: now },
      }),
      prisma.delegationSession.updateMany({
        where: { userId, revokedAt: null, ...tenantFilter },
        data: { revokedAt: now },
      }),
    ]);

    let cacheTombstoneFailures = 0;
    if (targetSessions.length > 0) {
      const cacheResult = await invalidateCachedSessions(
        targetSessions.map((s) => s.sessionToken),
      );
      cacheTombstoneFailures = cacheResult.failed;
    }

    return {
      sessions: sessionsResult.count,
      extensionTokens: extensionTokensResult.count,
      apiKeys: apiKeysResult.count,
      mcpAccessTokens: mcpAccessTokensResult.count,
      mcpRefreshTokens: mcpRefreshTokensResult.count,
      delegationSessions: delegationSessionsResult.count,
      cacheTombstoneFailures,
    };
  }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);
}

/**
 * Invalidate the session cache for every active session in a tenant.
 *
 * Used by tenant policy changes (e.g., toggling requirePasskey) to ensure
 * the cached SessionInfo on every worker reflects the new policy within
 * one cache-cycle (≤ TOMBSTONE_TTL_MS). Pipelined Redis tombstones — single
 * round-trip for thousands of tokens (S-13).
 *
 * Lives here (not in the route handler) so the bypass-rls call inherits
 * the existing user-session-invalidation.ts allowlist for the `session`
 * model — the tenant route does NOT need its own session-model bypass.
 *
 * Returns `{ totalSessions, cacheTombstoneFailures }` so the caller can
 * include the failure count in POLICY_UPDATE audit metadata — a Redis
 * outage during a tenant policy tightening (e.g., requirePasskey on)
 * leaves stale-policy sessions cached on workers, and that gap MUST be
 * forensically visible.
 */
export async function invalidateTenantSessionsCache(
  tenantId: string,
): Promise<{ totalSessions: number; cacheTombstoneFailures: number }> {
  const targetSessions = await withBypassRls(prisma, () =>
    prisma.session.findMany({
      where: { tenantId, expires: { gt: new Date() } },
      select: { sessionToken: true },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (targetSessions.length === 0) {
    return { totalSessions: 0, cacheTombstoneFailures: 0 };
  }

  const result = await invalidateCachedSessionsBulk(
    targetSessions.map((s) => s.sessionToken),
  );
  return {
    totalSessions: result.total,
    cacheTombstoneFailures: result.failed,
  };
}
