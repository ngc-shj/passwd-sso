import type { Prisma } from "@prisma/client";

/**
 * Counters for every model a realignment can strand — one per model the user
 * owns that is also tenant-scoped, so the row stays filed under the tenant that
 * released them while the user's requests scope by the new one.
 *
 * A MAP, not a fixed triple. The first version counted `passwordEntry` / `tag` /
 * `folder` and nothing else, so `{0,0,0}` read as "nothing stranded" for a user
 * whose passkeys, tokens and sessions were all still in the old tenant — and
 * `webAuthnCredential` has a user-visible consequence the "empty vault" framing
 * missed: `api/webauthn/credentials` lists under `withUserTenantRls` (the NEW
 * tenant) while `derivePasskeyState` counts under a bypass by userId alone, so
 * the user is told they have a passkey, sees none, and cannot manage them.
 *
 * The member set is DERIVED, not listed: `tenant-context.stranded-models.test.ts`
 * parses `prisma/schema.prisma` for every model declaring `tenantId` beside a
 * user column and fails when one is neither counted here nor named in that
 * test's exclusion map with a reason. A model added later shows up as a failing
 * test rather than as a silent zero.
 */
export const STRANDED_COUNTERS = {
  account: (tx, userId, tenantId) => tx.account.count({ where: { userId, tenantId } }),
  apiKey: (tx, userId, tenantId) => tx.apiKey.count({ where: { userId, tenantId } }),
  attachment: (tx, userId, tenantId) =>
    tx.attachment.count({ where: { createdById: userId, tenantId } }),
  delegationSession: (tx, userId, tenantId) =>
    tx.delegationSession.count({ where: { userId, tenantId } }),
  emergencyAccessGrant: (tx, userId, tenantId) =>
    tx.emergencyAccessGrant.count({ where: { ownerId: userId, tenantId } }),
  extensionBridgeCode: (tx, userId, tenantId) =>
    tx.extensionBridgeCode.count({ where: { userId, tenantId } }),
  extensionToken: (tx, userId, tenantId) =>
    tx.extensionToken.count({ where: { userId, tenantId } }),
  folder: (tx, userId, tenantId) => tx.folder.count({ where: { userId, tenantId } }),
  mcpAccessToken: (tx, userId, tenantId) =>
    tx.mcpAccessToken.count({ where: { userId, tenantId } }),
  mcpAuthorizationCode: (tx, userId, tenantId) =>
    tx.mcpAuthorizationCode.count({ where: { userId, tenantId } }),
  mcpRefreshToken: (tx, userId, tenantId) =>
    tx.mcpRefreshToken.count({ where: { userId, tenantId } }),
  mobileBridgeCode: (tx, userId, tenantId) =>
    tx.mobileBridgeCode.count({ where: { userId, tenantId } }),
  notification: (tx, userId, tenantId) =>
    tx.notification.count({ where: { userId, tenantId } }),
  passwordEntry: (tx, userId, tenantId) =>
    tx.passwordEntry.count({ where: { userId, tenantId } }),
  passwordShare: (tx, userId, tenantId) =>
    tx.passwordShare.count({ where: { createdById: userId, tenantId } }),
  session: (tx, userId, tenantId) => tx.session.count({ where: { userId, tenantId } }),
  tag: (tx, userId, tenantId) => tx.tag.count({ where: { userId, tenantId } }),
  teamMemberKey: (tx, userId, tenantId) =>
    tx.teamMemberKey.count({ where: { userId, tenantId } }),
  teamPasswordFavorite: (tx, userId, tenantId) =>
    tx.teamPasswordFavorite.count({ where: { userId, tenantId } }),
  vaultKey: (tx, userId, tenantId) => tx.vaultKey.count({ where: { userId, tenantId } }),
  webAuthnCredential: (tx, userId, tenantId) =>
    tx.webAuthnCredential.count({ where: { userId, tenantId } }),
} satisfies Record<
  string,
  (db: Prisma.TransactionClient, userId: string, tenantId: string) => Promise<number>
>;

/**
 * How many rows of each kind the user still owns under `tenantId`.
 *
 * Zero-valued keys are DROPPED. The audit row an operator reads should carry
 * what is stranded, not twenty-one zeroes with two numbers hidden among them —
 * and an empty object is then the honest encoding of "nothing left behind".
 */
export async function countStrandedRows(
  db: Prisma.TransactionClient,
  userId: string,
  tenantId: string,
): Promise<Record<string, number>> {
  const entries = Object.entries(STRANDED_COUNTERS);
  const counts = await Promise.all(entries.map(([, count]) => count(db, userId, tenantId)));
  return Object.fromEntries(
    entries.map(([model], i) => [model, counts[i]] as const).filter(([, n]) => n > 0),
  );
}
