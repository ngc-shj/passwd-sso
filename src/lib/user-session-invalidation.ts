import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";

/**
 * Invalidate all sessions and tokens for a user.
 * Called on: team member removal, SCIM user deletion/deactivation.
 *
 * Uses withBypassRls() scoped to the target userId WHERE clause.
 */
export async function invalidateUserSessions(
  userId: string,
  options?: { tenantId?: string; reason?: string },
): Promise<{ sessions: number; extensionTokens: number; apiKeys: number }> {
  const tenantFilter = options?.tenantId ? { tenantId: options.tenantId } : {};

  return withBypassRls(prisma, async () => {
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

    return {
      sessions: sessionsResult.count,
      extensionTokens: extensionTokensResult.count,
      apiKeys: apiKeysResult.count,
    };
  });
}
