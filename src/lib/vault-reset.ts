/**
 * Shared vault reset logic used by both self-reset and admin-initiated reset.
 *
 * Deletes all vault data for a target user in a single transaction.
 * The caller must handle RLS context, audit logging, and authorization.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";

export interface VaultResetResult {
  deletedEntries: number;
  deletedAttachments: number;
}

/**
 * Execute a complete vault reset for the target user.
 *
 * Uses bypassRls to ensure all data is accessible regardless of tenant context
 * (admin-initiated resets may cross tenant boundaries within the same team).
 *
 * @param targetUserId - The user whose vault will be wiped
 * @returns Counts of deleted entries and attachments (for audit metadata)
 */
export async function executeVaultReset(
  targetUserId: string,
): Promise<VaultResetResult> {
  // Count data being deleted for audit metadata
  const [deletedEntries, deletedAttachments] = await withBypassRls(
    prisma,
    async () =>
      Promise.all([
        prisma.passwordEntry.count({ where: { userId: targetUserId } }),
        prisma.attachment.count({ where: { createdById: targetUserId } }),
      ]),
  );

  // Single transaction: delete all vault data
  await withBypassRls(prisma, async () =>
    prisma.$transaction([
      // Attachments (bytea stored directly in DB, no external storage)
      prisma.attachment.deleteMany({ where: { createdById: targetUserId } }),
      // Share links
      prisma.passwordShare.deleteMany({
        where: { createdById: targetUserId },
      }),
      // Password entries
      prisma.passwordEntry.deleteMany({ where: { userId: targetUserId } }),
      // Vault keys
      prisma.vaultKey.deleteMany({ where: { userId: targetUserId } }),
      // Tags (all entries deleted, tags are now orphaned)
      prisma.tag.deleteMany({ where: { userId: targetUserId } }),
      // Emergency access grants (revoke as owner)
      prisma.emergencyAccessGrant.updateMany({
        where: { ownerId: targetUserId },
        data: { status: "REVOKED", revokedAt: new Date() },
      }),
      // Team E2E: delete all TeamMemberKey records for this user
      prisma.teamMemberKey.deleteMany({ where: { userId: targetUserId } }),
      // Team E2E: reset keyDistributed on all TeamMember records for this user
      prisma.teamMember.updateMany({
        where: { userId: targetUserId },
        data: { keyDistributed: false },
      }),
      // Null out vault + recovery + lockout + ECDH fields on User
      prisma.user.update({
        where: { id: targetUserId },
        data: {
          vaultSetupAt: null,
          accountSalt: null,
          encryptedSecretKey: null,
          secretKeyIv: null,
          secretKeyAuthTag: null,
          masterPasswordServerHash: null,
          masterPasswordServerSalt: null,
          keyVersion: 0,
          passphraseVerifierHmac: null,
          passphraseVerifierVersion: 1,
          // Recovery key fields
          recoveryEncryptedSecretKey: null,
          recoverySecretKeyIv: null,
          recoverySecretKeyAuthTag: null,
          recoveryHkdfSalt: null,
          recoveryVerifierHmac: null,
          recoveryKeySetAt: null,
          // Lockout fields
          failedUnlockAttempts: 0,
          lastFailedUnlockAt: null,
          accountLockedUntil: null,
          // ECDH key pair (team E2E)
          ecdhPublicKey: null,
          encryptedEcdhPrivateKey: null,
          ecdhPrivateKeyIv: null,
          ecdhPrivateKeyAuthTag: null,
        },
      }),
    ]),
  );

  return { deletedEntries, deletedAttachments };
}
