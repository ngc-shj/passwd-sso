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
import { logAuditInTx, type AuditLogParams } from "@/lib/audit/audit";

export interface VaultResetResult {
  deletedEntries: number;
  deletedAttachments: number;
}

/**
 * Atomic audit event (#6): enqueued via logAuditInTx INSIDE the destructive
 * transaction, so the irreversible vault wipe can never commit without a
 * committed audit record of the fact + deletion counts. `deletedEntries` /
 * `deletedAttachments` are added by executeVaultReset — the caller supplies the
 * audit base (scope/action/actor/target). Post-reset completion detail
 * (invalidated-session counts) stays a separate best-effort logAuditAsync event
 * at the caller, since those happen after this transaction.
 */
export interface VaultResetAtomicAudit {
  tenantId: string;
  params: Omit<AuditLogParams, "metadata"> & {
    metadata?: Record<string, unknown>;
  };
}

/**
 * A tenant-scoped reset refused because the user still owns vault rows under a
 * different tenant. `outside` names the kinds and counts, never the tenant.
 */
export class VaultResetOutsideTenantError extends Error {
  constructor(readonly outside: Readonly<Record<string, number>>) {
    super("VAULT_RESET_DATA_OUTSIDE_TENANT");
    this.name = "VaultResetOutsideTenantError";
  }
}

/**
 * Personal vault rows this user owns under any tenant other than `tenantId`,
 * limited to the kinds a reset destroys. Zero-count kinds are dropped, so an
 * empty object means "nothing outside".
 *
 * Why this exists: a realignment (`realignOwningTenantColumn`) moves the user's
 * owning tenant and deliberately leaves their rows filed under the tenant that
 * released them — reattachable later, which is what made that the chosen
 * option. `executeVaultReset` deletes by user alone, so an admin reset
 * authorized in the NEW tenant would destroy rows that tenant has no authority
 * over, and which neither the admin nor the user can see under RLS.
 *
 * Team-side rows are excluded: `teamMemberKey`, and attachments or shares on a
 * TEAM entry, legitimately live under a team's tenant when the user is a guest
 * there, so counting them would refuse an ordinary reset.
 */
async function countVaultRowsOutsideTenant(
  tx: Prisma.TransactionClient,
  userId: string,
  tenantId: string,
): Promise<Record<string, number>> {
  const outside = { not: tenantId };
  const [passwordEntry, tag, folder, vaultKey, attachment, passwordShare, emergencyAccessGrant] =
    await Promise.all([
      tx.passwordEntry.count({ where: { userId, tenantId: outside } }),
      tx.tag.count({ where: { userId, tenantId: outside } }),
      tx.folder.count({ where: { userId, tenantId: outside } }),
      tx.vaultKey.count({ where: { userId, tenantId: outside } }),
      tx.attachment.count({
        where: { createdById: userId, teamPasswordEntryId: null, tenantId: outside },
      }),
      tx.passwordShare.count({
        where: { createdById: userId, teamPasswordEntryId: null, tenantId: outside },
      }),
      tx.emergencyAccessGrant.count({ where: { ownerId: userId, tenantId: outside } }),
    ]);
  return Object.fromEntries(
    Object.entries({
      passwordEntry,
      tag,
      folder,
      vaultKey,
      attachment,
      passwordShare,
      emergencyAccessGrant,
    }).filter(([, n]) => n > 0),
  );
}

/**
 * The same question outside any transaction, for a route that must refuse
 * BEFORE it consumes something — the execute route's one-shot token, or an
 * admin's daily initiate quota. Not the enforcement: the scoped reset re-asks
 * inside its own transaction, after locking the user row.
 */
export async function findVaultRowsOutsideTenant(
  userId: string,
  tenantId: string,
): Promise<Record<string, number>> {
  return withBypassRls(
    prisma,
    (tx) => countVaultRowsOutsideTenant(tx, userId, tenantId),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );
}

/**
 * Execute a complete vault reset for the target user.
 *
 * Unscoped, it deletes the user's vault rows under every tenant: the owner's own
 * reset (`/api/vault/reset`), whose authority covers all of them. An
 * ADMIN-authorized reset passes `scopeTenantId` and is refused with
 * `VaultResetOutsideTenantError`, deleting nothing, while the user still owns
 * personal vault rows under any other tenant. That check runs inside the
 * deleting transaction after the user row is locked, so a realignment
 * committing concurrently is serialized against it instead of landing between
 * the check and the delete.
 *
 * The destructive body stays in THIS exported function, under this name:
 * `route-class-patterns.json#deleteSignal` names it, and both the route
 * classifier and `check-destructive-wrapper-derivation` find destructive routes
 * through it. Moving the body behind a differently named wrapper declassified
 * `/api/vault/admin-reset` — measured: `check-permanent-delete-stepup.sh`
 * reported that route's exemption stale, and the derivation gate reported this
 * name stale.
 *
 * @param targetUserId - The user whose vault will be wiped
 * @param atomicAudit - Its own argument, not a field of `options`:
 *   `check-critical-audit-atomic` credits a critical action only when its
 *   `{ params: { action } }` descriptor is a direct call argument. Measured —
 *   nesting it inside an options object made both reset actions read as
 *   non-atomic.
 * @param options.__testHook - TEST-ONLY: injected after bulkTransition inside
 *   the transaction. Throwing from the hook asserts atomicity (T16 / S4).
 *   Ignored in non-test environments even if passed. Never use in production.
 * @returns Counts of deleted entries and attachments (for audit metadata)
 */
export async function executeVaultReset(
  targetUserId: string,
  atomicAudit?: VaultResetAtomicAudit,
  options: {
    scopeTenantId?: string;
    __testHook?: (tx: Prisma.TransactionClient) => Promise<void>;
  } = {},
): Promise<VaultResetResult> {
  const { scopeTenantId, __testHook } = options;
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

    if (scopeTenantId) {
      const outside = await countVaultRowsOutsideTenant(tx, targetUserId, scopeTenantId);
      if (Object.keys(outside).length > 0) {
        throw new VaultResetOutsideTenantError(outside);
      }
    }

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

    // #6: atomic audit of the destructive fact, INSIDE this transaction. If the
    // wipe rolls back, so does the audit row; if it commits, the audit row
    // commits with it — closing the "vault wiped, no audit trail" window that
    // a post-commit logAuditAsync leaves open on a crash.
    if (atomicAudit) {
      await logAuditInTx(tx, atomicAudit.tenantId, {
        ...atomicAudit.params,
        metadata: {
          ...(atomicAudit.params.metadata ?? {}),
          deletedEntries,
          deletedAttachments,
        },
      });
    }

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
