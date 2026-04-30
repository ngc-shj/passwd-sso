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
 * Invalidate all sessions and tokens for a user.
 * Called on: team member removal, SCIM user deletion/deactivation,
 * and admin vault reset (cross-tenant via `allTenants: true`).
 *
 * Uses withBypassRls() scoped to the target userId WHERE clause.
 */
export async function invalidateUserSessions(
  userId: string,
  options: InvalidateUserSessionsOptions,
): Promise<{ sessions: number; extensionTokens: number; apiKeys: number }> {
  // Defense-in-depth: discriminated union prevents this at compile time,
  // but a runtime cast (`as any`) could still leak both options through.
  if (options.tenantId && options.allTenants) {
    throw new Error(
      "invalidateUserSessions: tenantId and allTenants are mutually exclusive",
    );
  }

  const allTenants = "allTenants" in options && options.allTenants === true;
  const tenantFilter = allTenants ? {} : { tenantId: options.tenantId };

  return withBypassRls(prisma, async () => {
    // SELECT tokens before deleteMany so we can invalidate the cache after
    // the DB delete commits (R3 / S-6 sequencing).
    const targetSessions = await prisma.session.findMany({
      where: { userId, ...tenantFilter },
      select: { sessionToken: true },
    });

    const [sessionsResult, extensionTokensResult, apiKeysResult] =
      await Promise.all([
        prisma.session.deleteMany({
          where: { userId, ...tenantFilter },
        }),
        prisma.extensionToken.updateMany({
          where: { userId, revokedAt: null, ...tenantFilter },
          data: { revokedAt: new Date() },
        }),
        prisma.apiKey.updateMany({
          where: { userId, revokedAt: null, ...tenantFilter },
          data: { revokedAt: new Date() },
        }),
      ]);

    if (targetSessions.length > 0) {
      await invalidateCachedSessions(
        targetSessions.map((s) => s.sessionToken),
      );
    }

    return {
      sessions: sessionsResult.count,
      extensionTokens: extensionTokensResult.count,
      apiKeys: apiKeysResult.count,
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
 */
export async function invalidateTenantSessionsCache(
  tenantId: string,
): Promise<void> {
  const targetSessions = await withBypassRls(prisma, () =>
    prisma.session.findMany({
      where: { tenantId, expires: { gt: new Date() } },
      select: { sessionToken: true },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (targetSessions.length > 0) {
    await invalidateCachedSessionsBulk(
      targetSessions.map((s) => s.sessionToken),
    );
  }
}
