import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";

/**
 * Revoke the sessions named by `rawTokens` that belong to `userId`, the user
 * a sign-out just signed out. Auth.js revokes only the session of the first
 * cookie it reads; a browser can hold more (both CHIPS variants after a
 * COOKIE_PARTITIONED flip, an older cookie name), and those would stay alive
 * after the browser drops their cookies.
 *
 * Ownership is part of each delete's WHERE: a cookie in this request that
 * names another user's session does not let this sign-out revoke it. Only the
 * rows actually deleted are invalidated in the cache — a tombstone for a
 * session left alive would cut it off for the tombstone's lifetime.
 */
export async function revokeSignedOutUserSessions(
  userId: string,
  rawTokens: readonly string[],
): Promise<void> {
  if (rawTokens.length === 0) return;
  const revoked = await withBypassRls(
    prisma,
    async (tx) => {
      const digests: string[] = [];
      for (const token of rawTokens) {
        const digest = hashSessionToken(token);
        const { count } = await tx.session.deleteMany({
          where: { sessionToken: digest, userId },
        });
        if (count > 0) digests.push(digest);
      }
      return digests;
    },
    BYPASS_GRANT.AUTH_SESSION_LIFECYCLE,
  );
  await invalidateCachedSessions(revoked);
}
