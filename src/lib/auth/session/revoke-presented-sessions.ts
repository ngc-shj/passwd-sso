import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";

/**
 * Revoke the sessions named by `rawTokens` — the session cookies a response
 * is about to delete from the browser (a sign-out, the proxy's refusal). A
 * CHIPS browser can hold the cookie partitioned and unpartitioned; Auth.js
 * revokes at most the session of the first one it reads, and the proxy's
 * refusal revokes none, so without this the other cookie's session stays
 * alive server-side after the browser has dropped the cookie.
 *
 * No ownership check: the caller holds each raw token, and sending that token
 * alone as the session cookie to sign-out already revokes its session (the
 * same reasoning as the sign-in replacement, issue #966). Tokens come from
 * `presentedSessionTokens`, which keeps only well-formed values and bounds
 * how many.
 *
 * Only the rows actually deleted are invalidated in the cache: a tombstone for
 * a token that named no session would be a write with nothing to revoke.
 */
export async function revokePresentedSessions(rawTokens: readonly string[]): Promise<void> {
  if (rawTokens.length === 0) return;
  const revoked = await withBypassRls(
    prisma,
    async (tx) => {
      const digests: string[] = [];
      for (const token of rawTokens) {
        const digest = hashSessionToken(token);
        const { count } = await tx.session.deleteMany({ where: { sessionToken: digest } });
        if (count > 0) digests.push(digest);
      }
      return digests;
    },
    BYPASS_GRANT.AUTH_SESSION_LIFECYCLE,
  );
  await invalidateCachedSessions(revoked);
}
