import type { Prisma } from "@prisma/client";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";

/**
 * Typed error thrown when a personal-vault write carries a keyVersion that no
 * longer matches the owner's current vault key. Routes map it to a 409
 * KEY_VERSION_MISMATCH envelope; the service layer lets it propagate so the
 * enclosing transaction rolls back (no partial stale-version write).
 */
export class KeyVersionMismatchError extends Error {
  readonly code: ApiErrorCode = API_ERROR.KEY_VERSION_MISMATCH;
  constructor(
    readonly expected: number | null,
    readonly received: number,
  ) {
    super(
      `Vault keyVersion mismatch: expected ${expected ?? "<none>"}, received ${received}`,
    );
    this.name = "KeyVersionMismatchError";
  }
}

type UserKeyVersionRow = { key_version: number };

/**
 * Reject a personal-vault write whose `keyVersion` does not equal the owner's
 * current `users.key_version`, closing the stale-write race with key rotation:
 * a leaked/held client key at version N could otherwise relabel a v(N+1) blob
 * back to vN and render the entry permanently undecryptable.
 *
 * MUST run inside an open transaction — the `FOR SHARE` row lock is only
 * load-bearing while the transaction is open. A bare (autocommitting) client
 * degrades the guard to an unlocked re-read, so the param type is narrowed to
 * the tx-client surface (mirrors `advisoryXactLock`). At the service member
 * site (bulk-import → createPersonalPasswordEntry) the ambient-RLS Prisma proxy
 * folds the call into the surrounding `withUserTenantRls` transaction.
 *
 * Fails closed: a zero-row result (user row RLS-filtered or deleted mid-flight)
 * throws rather than silently passing.
 *
 * Lock order: acquire `users` (this FOR SHARE) BEFORE any `password_entries`
 * row lock in the same transaction — every personal-vault transaction follows
 * users → password_entries so no deadlock cycle can form.
 */
export async function assertCurrentKeyVersion(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
  keyVersion: number,
): Promise<void> {
  const rows = await tx.$queryRaw<UserKeyVersionRow[]>`
    SELECT key_version FROM users WHERE id = ${userId}::uuid FOR SHARE
  `;
  const current = rows[0];
  if (!current) {
    // Fail closed: no owner row visible means we cannot prove the version.
    throw new KeyVersionMismatchError(null, keyVersion);
  }
  if (current.key_version !== keyVersion) {
    throw new KeyVersionMismatchError(current.key_version, keyVersion);
  }
}
