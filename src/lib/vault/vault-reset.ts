/**
 * Shared vault reset logic used by both self-reset and admin-initiated reset.
 *
 * Deletes all vault data for a target user in a single transaction.
 * The caller must handle RLS context, audit logging, and authorization.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  collectAttachmentRefsByCreator,
  deleteAttachmentBlobs,
} from "@/lib/blob-store/cleanup";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { bulkTransition } from "@/lib/emergency-access/emergency-access-state";
import { EA_STATUS, EA_ACTOR } from "@/lib/constants";

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
 * @param __testHook   - TEST-ONLY: injected after bulkTransition inside the
 *                       transaction. Throwing from the hook asserts atomicity
 *                       (T16 / S4). Ignored in non-test environments even if
 *                       passed. Never use in production code.
 * @returns Counts of deleted entries and attachments (for audit metadata)
 */
export async function executeVaultReset(
  targetUserId: string,
  __testHook?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<VaultResetResult> {
  // Count data being deleted for audit metadata
  const [deletedEntries, deletedAttachments] = await withBypassRls(
    prisma,
    async (tx) =>
      Promise.all([
        tx.passwordEntry.count({ where: { userId: targetUserId } }),
        tx.attachment.count({ where: { createdById: targetUserId } }),
      ]),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );

  // Single transaction: delete all vault data (callback form required for bulkTransition — S4).
  const attachmentRefs = await withBypassRls(prisma, async (tx) => {
    // Lock order: users row FIRST, before any password_entries row lock —
    // mirrors the invariant in rotate-key-server.ts. Without this, a guarded
    // write holding the users FOR SHARE while waiting on an entry row here
    // (entries locked first, users updated last) would form a deadlock cycle.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${targetUserId}::uuid FOR UPDATE`;

    // Attachments: rows are bytea in DB, but external blob backends store the
    // ciphertext out-of-band — capture refs before delete so they aren't
    // orphaned, then purge after the transaction commits.
    const refs = await collectAttachmentRefsByCreator(tx, targetUserId);
    await tx.attachment.deleteMany({ where: { createdById: targetUserId } });
    // Share links
    await tx.passwordShare.deleteMany({ where: { createdById: targetUserId } });
    // Password entries
    await tx.passwordEntry.deleteMany({ where: { userId: targetUserId } });
    // Vault keys
    await tx.vaultKey.deleteMany({ where: { userId: targetUserId } });
    // Tags (all entries deleted, tags are now orphaned)
    await tx.tag.deleteMany({ where: { userId: targetUserId } });
    // Folders (user-owned, not cascade-deleted by PasswordEntry removal)
    await tx.folder.deleteMany({ where: { userId: targetUserId } });
    // Emergency access grants (revoke as owner — matrix-validated via bulkTransition).
    // actor: "OWNER" because the matrix models vault-reset as the owner's own revocation
    // (the user's grants as owner are wiped; SYSTEM has no REVOKED matrix entry).
    await bulkTransition({
      db: tx,
      where: { ownerId: targetUserId },
      to: EA_STATUS.REVOKED,
      actor: EA_ACTOR.OWNER,
      extraData: { revokedAt: new Date() },
    });
    // Team E2E: delete all TeamMemberKey records for this user
    await tx.teamMemberKey.deleteMany({ where: { userId: targetUserId } });
    // Team E2E: reset keyDistributed on all TeamMember records for this user
    await tx.teamMember.updateMany({
      where: { userId: targetUserId },
      data: { keyDistributed: false },
    });
    // Null out vault + recovery + lockout + ECDH fields on User
    await tx.user.update({
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
        passphraseVerifierVersion: VERIFIER_VERSION,
        // Recovery key fields
        recoveryEncryptedSecretKey: null,
        recoverySecretKeyIv: null,
        recoverySecretKeyAuthTag: null,
        recoveryHkdfSalt: null,
        recoveryVerifierHmac: null,
        recoveryVerifierVersion: VERIFIER_VERSION,
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
    });

    // TEST-ONLY: failure-injection hook (T16 / S4 atomicity). Never runs in production.
    if (process.env.NODE_ENV === "test" && __testHook) {
      await __testHook(tx);
    }

    return refs;
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  // Purge external blob objects only after the DB transaction commits
  // (best-effort; no-op on the DB backend).
  await deleteAttachmentBlobs(attachmentRefs);

  return { deletedEntries, deletedAttachments };
}
