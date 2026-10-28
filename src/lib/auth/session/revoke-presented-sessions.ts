import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";

/**
 * Revoke the sessions named by `rawTokens` — the configured session cookie,
 * both CHIPS variants, that a response is about to delete from the browser (a
 * sign-out, the proxy's refusal). A CHIPS browser can hold that cookie
 * partitioned and unpartitioned; Auth.js revokes at most the session of the
 * first one it reads, and the proxy's refusal revokes none, so without this
 * the other variant's session stays alive server-side after the browser has
 * dropped the cookie. Legacy cookie names are not passed here: they are
 * deleted only as leftovers from before a configuration change, and the
 * current configuration never authenticates them.
 *
 * No ownership check: the caller holds each raw token, and sending that token
 * alone as the session cookie to sign-out already revokes its session (the
 * same reasoning as the sign-in replacement, issue #966). Tokens come from
 * `presentedSessionTokens`, which keeps only well-formed values and bounds
 * how many.
 *
 * Returns the rows actually deleted (digest and owner), so a sign-out can
 * audit the sessions it ended; only those rows are invalidated in the cache —
 * a tombstone for a token that named no session would be a write with nothing
 * to revoke.
 */
export async function revokePresentedSessions(
  rawTokens: readonly string[],
): Promise<ReadonlyArray<{ sessionToken: string; userId: string }>> {
  if (rawTokens.length === 0) return [];
  const revoked = await withBypassRls(
    prisma,
    async (tx) => {
      const rows: { sessionToken: string; userId: string }[] = [];
      for (const token of rawTokens) {
        const digest = hashSessionToken(token);
        const row = await tx.session.findUnique({
          where: { sessionToken: digest },
          select: { sessionToken: true, userId: true },
        });
        if (!row) continue;
        const { count } = await tx.session.deleteMany({ where: { sessionToken: digest } });
        if (count > 0) rows.push(row);
      }
      return rows;
    },
    BYPASS_GRANT.AUTH_SESSION_LIFECYCLE,
  );
  if (revoked.length > 0) {
    await invalidateCachedSessions(revoked.map((row) => row.sessionToken));
  }
  return revoked;
}
