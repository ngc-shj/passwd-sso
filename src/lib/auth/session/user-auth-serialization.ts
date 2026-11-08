/**
 * Serializes revoking a user's credentials against minting new ones.
 *
 * `revokeUserAuthArtifactsInTx` (every revocation: vault reset, member removal,
 * SCIM deactivation, the admin passkey revoke), the bootstrap→SSO tenant
 * migration in src/auth.ts (it revokes the user's tokens itself) and every path
 * that mints a
 * user-bound credential — a session, an extension / iOS / autofill / MCP
 * token, an API key, an operator token, a delegation, a single-use code —
 * take the same transaction-scoped lock on the user. A mint therefore runs
 * wholly before a revocation (which then revokes what it minted) or wholly
 * after it; in the second case the mint must find that what authenticated it
 * is gone, so each mint re-checks its proof INSIDE the locked transaction:
 *
 *   - a session-authenticated mint: the caller's session row still exists
 *     (`isSessionRowLive`);
 *   - a token-authenticated mint or a refresh: the token row is still
 *     unrevoked (`isTokenRowLive`, or the refresh's own compare-and-set);
 *   - a code exchange: the code is consumed in the same transaction.
 *
 * The per-user credential caps (session cap, extension/iOS family caps, API
 * keys, bridge codes) serialize on this same lock, so a cap and a revocation
 * are one lock and no ordering between them can deadlock. Take it first in the
 * transaction, before any row lock.
 *
 * Its key is namespaced (`user-auth:<userId>`), apart from the bare-user-id
 * lock that vault data paths hold (key rotation for up to its 2-minute
 * transaction, attachments, file sends): a revocation must not queue behind a
 * key rotation and time out — its callers on SCIM deactivation and team
 * removal carry on when it fails.
 */
import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { advisoryXactLock } from "@/lib/tenant-rls";
import { getSessionTokenDigest } from "@/app/api/sessions/helpers";

export async function lockUserAuthArtifacts(
  tx: Parameters<typeof advisoryXactLock>[0],
  userId: string,
): Promise<void> {
  await advisoryXactLock(tx, userAuthLockKey(userId));
}

/** The credential lock's key; namespaced apart from the vault-data lock on the bare user id. */
export function userAuthLockKey(userId: string): string {
  return `user-auth:${userId}`;
}

/**
 * The session this request presents still exists and is unexpired, read in
 * the caller's (locked) transaction. False with no session cookie: a mint that
 * is not session-authenticated checks its own proof instead.
 */
export async function isSessionRowLive(
  tx: Pick<Prisma.TransactionClient, "session">,
  req: NextRequest,
  userId: string,
): Promise<boolean> {
  const digest = getSessionTokenDigest(req);
  if (!digest) return false;
  const row = await tx.session.findFirst({
    where: { sessionToken: digest, userId, expires: { gt: new Date() } },
    select: { id: true },
  });
  return row !== null;
}

/** An extension-family token row (extension, iOS, autofill) is still unrevoked and unexpired. */
export async function isTokenRowLive(
  tx: Pick<Prisma.TransactionClient, "extensionToken">,
  tokenId: string,
  userId: string,
): Promise<boolean> {
  const row = await tx.extensionToken.findFirst({
    where: { id: tokenId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return row !== null;
}

/** A mint whose proof was revoked while it waited for the lock. */
export class UserAuthRevokedError extends Error {
  constructor(readonly proof: "session" | "token" | "code" | "credential") {
    super(`user credential revoked before issuance (${proof})`);
    this.name = "UserAuthRevokedError";
  }
}
