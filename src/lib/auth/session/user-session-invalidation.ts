import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";

/**
 * Invalidate all sessions and tokens for a user.
 * Called on: team member removal, SCIM user deletion/deactivation.
 *
 * Uses withBypassRls() scoped to the target userId WHERE clause.
 */
export async function invalidateUserSessions(
  userId: string,
  options: { tenantId: string; reason?: string },
): Promise<{ sessions: number; extensionTokens: number; apiKeys: number }> {
  const tenantFilter = { tenantId: options.tenantId };

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
