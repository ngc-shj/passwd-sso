import { type NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { auth } from "@/auth";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { prisma } from "@/lib/prisma";
import { markGrantsStaleForOwner } from "@/lib/emergency-access/emergency-access-server";
import { invalidateUserSessions } from "@/lib/auth/session/user-session-invalidation";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { z } from "zod";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, rateLimited, unauthorized, validationError, zodValidationError } from "@/lib/http/api-response";
import {
  hexIv,
  hexAuthTag,
  hexSalt,
  hexHash,
  encryptedFieldSchema,
  verificationArtifactSchema,
  VAULT_ROTATE_ENTRIES_MAX,
  VAULT_ROTATE_HISTORY_MAX,
  ECDH_PRIVATE_KEY_CIPHERTEXT_MAX,
} from "@/lib/validations/common";
import { AUDIT_ACTION } from "@/lib/constants";
import { toBlobColumns, toOverviewColumns } from "@/lib/crypto/crypto-blob";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const rotateLimiter = createRateLimiter({ windowMs: 15 * MS_PER_MINUTE, max: 3 });

const rotateKeySchema = z.object({
  // Current passphrase verification
  currentAuthHash: hexHash,
  // New vault wrapping data
  encryptedSecretKey: z.string().min(1).max(512),
  secretKeyIv: hexIv,
  secretKeyAuthTag: hexAuthTag,
  accountSalt: hexSalt,
  newAuthHash: hexHash,
  newVerifierHash: hexHash.optional(),
  verificationArtifact: verificationArtifactSchema,
  // Entry re-encryption payload — aadVersion must be >= 1 (AAD binding required)
  entries: z.array(z.object({
    id: z.string().uuid(),
    encryptedBlob: encryptedFieldSchema,
    encryptedOverview: encryptedFieldSchema,
    aadVersion: z.number().int().min(1),
  })).max(VAULT_ROTATE_ENTRIES_MAX),
  historyEntries: z.array(z.object({
    id: z.string().uuid(),
    encryptedBlob: encryptedFieldSchema,
    aadVersion: z.number().int().min(1),
  })).max(VAULT_ROTATE_HISTORY_MAX),
  // ECDH private key (re-wrapped with new secret key)
  encryptedEcdhPrivateKey: z.string().min(1).max(ECDH_PRIVATE_KEY_CIPHERTEXT_MAX),
  ecdhPrivateKeyIv: hexIv,
  ecdhPrivateKeyAuthTag: hexAuthTag,
  // Personal vault rotation orphans personal-entry attachments (encrypted with
  // the previous secretKey-derived encryption key). The client MUST set this
  // to `true` after the user explicitly acknowledges the data-loss warning,
  // otherwise rotation is rejected when any personal attachment exists.
  // Phase B (separate issue) will replace this with per-attachment CEK
  // indirection so rotation re-wraps the small CEK rather than the file body.
  acknowledgeAttachmentDataLoss: z.boolean().optional(),
});

// Cap on the per-rotation audit `affectedAttachmentIds` list. Each UUID is
// 36 chars; 1000 entries = ~40 KB JSON in the audit metadata column.
const ATTACHMENT_MANIFEST_CAP = 1000;

class AttachmentAckRequiredError extends Error {
  constructor(public readonly attachmentsAffected: number) {
    super("ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED");
    this.name = "AttachmentAckRequiredError";
  }
}

/**
 * POST /api/vault/rotate-key
 * Rotate the vault's secret key wrapping.
 * The client re-encrypts the secret key with a new passphrase and bumps keyVersion.
 * All password entries and history entries are re-encrypted atomically in a single
 * interactive transaction. All EA grants with older keyVersion are marked STALE.
 */
async function handlePOST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await rotateLimiter.check(`rl:vault_rotate:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }

  const parsed = rotateKeySchema.safeParse(body);
  if (!parsed.success) {
    // Truncate verbose Zod errors — the schema has ~3000 potential issues
    // (entries array × many fields each) that would blow up the response.
    if (parsed.error.issues.length > 10) {
      return validationError({ errors: [`Validation failed with ${parsed.error.issues.length} errors`] });
    }
    return zodValidationError(parsed.error);
  }
  const result = { ok: true as const, data: parsed.data };

  const userId = session.user.id;

  const user = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        tenantId: true,
        vaultSetupAt: true,
        masterPasswordServerHash: true,
        masterPasswordServerSalt: true,
        keyVersion: true,
      },
    }),
  );

  if (!user?.vaultSetupAt || !user.masterPasswordServerHash || !user.masterPasswordServerSalt) {
    return errorResponse(API_ERROR.VAULT_NOT_SETUP, 404);
  }

  // Verify current passphrase
  const computedHash = createHash("sha256")
    .update(result.data.currentAuthHash + user.masterPasswordServerSalt)
    .digest("hex");

  const hashA = Buffer.from(computedHash, "hex");
  const hashB = Buffer.from(user.masterPasswordServerHash, "hex");
  if (hashA.length !== hashB.length || !timingSafeEqual(hashA, hashB)) {
    return errorResponse(API_ERROR.INVALID_PASSPHRASE, 401);
  }

  const newKeyVersion = user.keyVersion + 1;
  const newServerSalt = randomBytes(32).toString("hex");
  const newServerHash = createHash("sha256")
    .update(result.data.newAuthHash + newServerSalt)
    .digest("hex");

  const {
    entries,
    historyEntries,
    encryptedEcdhPrivateKey,
    ecdhPrivateKeyIv,
    ecdhPrivateKeyAuthTag,
  } = result.data;

  // Update vault wrapping, bump keyVersion, re-encrypt all entries, clear orphan
  // wrappings (recovery / EA / PRF), and mark EA grants as STALE.
  // Interactive transaction with advisory lock prevents concurrent rotations for the same user.
  let txResult: {
    attachmentsAffected: number;
    affectedAttachmentIds: string[];
    affectedAttachmentIdsOverflow: boolean;
    recoveryKeyInvalidated: boolean;
    emergencyGrantsCleared: number;
    prfCredentialsCleared: number;
  };
  try {
    txResult = await withUserTenantRls(userId, async () =>
      prisma.$transaction(async (tx) => {
        // Advisory lock prevents concurrent key rotations for the same user (S-17 equivalent)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`;

        // ── Attachment data-loss safeguard ────────────────────────────────
        // Phase A interim: count personal-entry attachments (team attachments
        // are unaffected by personal rotation). Reject rotation unless the
        // client explicitly acknowledged the data-loss warning. The orphan
        // attachment rows remain in the DB so Phase B's recovery design has
        // material to work with — see plan #433 / A.4.
        // Use a real count query for `attachmentsAffected` so the user-facing
        // warning + audit metadata reflect the true attachment volume (a prior
        // findMany-with-take approach would silently cap at CAP+1, see #433
        // post-implementation review F4).
        const attachmentsAffected = await tx.attachment.count({
          where: { passwordEntry: { userId } },
        });
        if (attachmentsAffected > 0 && result.data.acknowledgeAttachmentDataLoss !== true) {
          throw new AttachmentAckRequiredError(attachmentsAffected);
        }
        // Manifest is capped — the ID list is for forensic recovery in Phase B,
        // not for UI display. The overflow flag below lets a forensic reader
        // see "we lost more than we recorded".
        const attachmentRows =
          attachmentsAffected > 0
            ? await tx.attachment.findMany({
                where: { passwordEntry: { userId } },
                select: { id: true },
                take: ATTACHMENT_MANIFEST_CAP,
              })
            : [];
        const affectedAttachmentIds = attachmentRows.map((a) => a.id);
        const affectedAttachmentIdsOverflow =
          attachmentsAffected > ATTACHMENT_MANIFEST_CAP;

        // Verify submitted entries exactly match ALL user entries (including trash/archived)
        const allEntries = await tx.passwordEntry.findMany({
          where: { userId },
          select: { id: true },
        });
        if (entries.length !== allEntries.length) {
          throw new Error("ENTRY_COUNT_MISMATCH");
        }
        const allEntryIdSet = new Set(allEntries.map((e) => e.id));
        const submittedEntryIdSet = new Set(entries.map((e) => e.id));
        if (
          submittedEntryIdSet.size !== entries.length ||
          submittedEntryIdSet.size !== allEntryIdSet.size
        ) {
          throw new Error("ENTRY_COUNT_MISMATCH");
        }
        for (const entryId of submittedEntryIdSet) {
          if (!allEntryIdSet.has(entryId)) {
            throw new Error("ENTRY_COUNT_MISMATCH");
          }
        }

        // Verify submitted historyEntries exactly match ALL user history records.
        // PasswordEntryHistory has no userId field — filter via nested relation.
        const allHistory = await tx.passwordEntryHistory.findMany({
          where: { entry: { userId } },
          select: { id: true },
        });
        if (historyEntries.length !== allHistory.length) {
          throw new Error("HISTORY_COUNT_MISMATCH");
        }
        const allHistoryIdSet = new Set(allHistory.map((h) => h.id));
        const submittedHistoryIdSet = new Set(historyEntries.map((h) => h.id));
        if (
          submittedHistoryIdSet.size !== historyEntries.length ||
          submittedHistoryIdSet.size !== allHistoryIdSet.size
        ) {
          throw new Error("HISTORY_COUNT_MISMATCH");
        }
        for (const historyId of submittedHistoryIdSet) {
          if (!allHistoryIdSet.has(historyId)) {
            throw new Error("HISTORY_COUNT_MISMATCH");
          }
        }

        // Re-encrypt all password entries with the new key.
        // updateMany + userId scope prevents cross-user updates.
        // Process in chunks to avoid overwhelming the DB with too many parallel statements.
        const ENTRY_BATCH_SIZE = 100;
        for (let i = 0; i < entries.length; i += ENTRY_BATCH_SIZE) {
          const batch = entries.slice(i, i + ENTRY_BATCH_SIZE);
          await Promise.all(batch.map(async (entry) => {
            const result = await tx.passwordEntry.updateMany({
              where: { id: entry.id, userId },
              data: {
                ...toBlobColumns(entry.encryptedBlob),
                ...toOverviewColumns(entry.encryptedOverview),
                aadVersion: entry.aadVersion,
                keyVersion: newKeyVersion,
              },
            });
            if (result.count !== 1) {
              throw new Error("ENTRY_COUNT_MISMATCH");
            }
          }));
        }

        // Re-encrypt all history blobs with the new key.
        // Filter via nested relation since PasswordEntryHistory has no userId field.
        // Process in chunks to avoid overwhelming the DB with too many parallel statements.
        const HISTORY_BATCH_SIZE = 100;
        for (let i = 0; i < historyEntries.length; i += HISTORY_BATCH_SIZE) {
          const batch = historyEntries.slice(i, i + HISTORY_BATCH_SIZE);
          await Promise.all(batch.map(async (historyEntry) => {
            const result = await tx.passwordEntryHistory.updateMany({
              where: { id: historyEntry.id, entry: { userId } },
              data: {
                ...toBlobColumns(historyEntry.encryptedBlob),
                aadVersion: historyEntry.aadVersion,
                keyVersion: newKeyVersion,
              },
            });
            if (result.count !== 1) {
              throw new Error("HISTORY_COUNT_MISMATCH");
            }
          }));
        }

        // Update user vault wrapping keys and ECDH private key. Also clear the
        // recovery wrapping (was over the OLD secretKey; useless against new
        // data after rotation) and stamp recoveryKeyInvalidatedAt so admins can
        // distinguish "never set up" from "lost via rotation". recoveryVerifierVersion
        // is non-nullable — reset to default 1, NOT null. See plan #433 / S5+F2.
        const recoveryWasSet = await tx.user.findUnique({
          where: { id: userId },
          select: { recoveryEncryptedSecretKey: true },
        });
        const recoveryKeyInvalidated = !!recoveryWasSet?.recoveryEncryptedSecretKey;

        await tx.user.update({
          where: { id: userId },
          data: {
            encryptedSecretKey: result.data.encryptedSecretKey,
            secretKeyIv: result.data.secretKeyIv,
            secretKeyAuthTag: result.data.secretKeyAuthTag,
            accountSalt: result.data.accountSalt,
            masterPasswordServerHash: newServerHash,
            masterPasswordServerSalt: newServerSalt,
            keyVersion: newKeyVersion,
            // Sync verifier with new accountSalt to keep change-passphrase working
            ...(result.data.newVerifierHash
              ? {
                  passphraseVerifierHmac: hmacVerifier(result.data.newVerifierHash),
                  passphraseVerifierVersion: VERIFIER_VERSION,
                }
              : {}),
            // Re-wrapped ECDH private key
            encryptedEcdhPrivateKey,
            ecdhPrivateKeyIv,
            ecdhPrivateKeyAuthTag,
            // Clear recovery wrapping (over old secretKey)
            recoveryEncryptedSecretKey: null,
            recoverySecretKeyIv: null,
            recoverySecretKeyAuthTag: null,
            recoveryHkdfSalt: null,
            recoveryVerifierHmac: null,
            recoveryVerifierVersion: 1,
            recoveryKeySetAt: null,
            recoveryKeyInvalidatedAt: new Date(),
          },
        });

        await tx.vaultKey.create({
          data: {
            userId,
            tenantId: user.tenantId,
            version: newKeyVersion,
            verificationCiphertext: result.data.verificationArtifact.ciphertext,
            verificationIv: result.data.verificationArtifact.iv,
            verificationAuthTag: result.data.verificationArtifact.authTag,
          },
        });

        // Clear PRF wrapping fields on every credential of this user. The
        // wrapping was over the OLD secretKey; the next passkey sign-in will
        // re-bootstrap PRF via the new endpoint. `prfSupported` is intentionally
        // NOT touched — it represents the authenticator's PRF capability, not
        // wrapping presence. See plan #433 / F8.
        const prfClearResult = await tx.webAuthnCredential.updateMany({
          where: { userId, prfEncryptedSecretKey: { not: null } },
          data: {
            prfEncryptedSecretKey: null,
            prfSecretKeyIv: null,
            prfSecretKeyAuthTag: null,
          },
        });

        // Mark EA grants STALE inside the rotation tx so atomicity is preserved.
        // The helper also nulls ownerEphemeralPublicKey (defeats ECDH unwrap
        // while preserving the wrapping ciphertext for forensic trail).
        // Behavior change vs prior best-effort post-tx call: an EA-table failure
        // now aborts the entire rotation. Trade-off accepted (#433 / F10 / S2).
        const emergencyGrantsCleared = await markGrantsStaleForOwner(userId, newKeyVersion, tx);

        return {
          attachmentsAffected,
          affectedAttachmentIds,
          affectedAttachmentIdsOverflow,
          recoveryKeyInvalidated,
          emergencyGrantsCleared,
          prfCredentialsCleared: prfClearResult.count,
        };
      }, { timeout: 120_000 }),
    );
  } catch (e) {
    if (e instanceof AttachmentAckRequiredError) {
      return errorResponse(
        API_ERROR.ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED,
        422,
        { attachmentsAffected: e.attachmentsAffected },
      );
    }
    if (e instanceof Error && e.message === "ENTRY_COUNT_MISMATCH") {
      return errorResponse(API_ERROR.ENTRY_COUNT_MISMATCH, 400);
    }
    if (e instanceof Error && e.message === "HISTORY_COUNT_MISMATCH") {
      return errorResponse(API_ERROR.ENTRY_COUNT_MISMATCH, 400);
    }
    throw e;
  }

  // Revoke ALL user-bound auth artifacts (Session, ExtensionToken, ApiKey,
  // McpAccessToken, McpRefreshToken, DelegationSession). Best-effort — placement
  // matches existing vault-reset audit shape (cacheTombstoneFailures captured
  // for forensic visibility on Redis outage). Replaces the prior single
  // revokeAllDelegationSessions call which left MCP tokens valid against the
  // freshly-rotated vault. See plan #433 / S-N2 + memory
  // feedback_user_bound_token_enumeration.md.
  const invalidationResult = await invalidateUserSessions(userId, {
    tenantId: user.tenantId,
    reason: "KEY_ROTATION",
  }).catch(() => null);

  await logAuditAsync({
    ...personalAuditBase(request, userId),
    action: AUDIT_ACTION.VAULT_KEY_ROTATION,
    targetType: "User",
    targetId: userId,
    metadata: {
      fromVersion: user.keyVersion,
      toVersion: newKeyVersion,
      entriesRotated: entries.length,
      historyEntriesRotated: historyEntries.length,
      recoveryKeyInvalidated: txResult.recoveryKeyInvalidated,
      emergencyGrantsCleared: txResult.emergencyGrantsCleared,
      prfCredentialsCleared: txResult.prfCredentialsCleared,
      attachmentsAffected: txResult.attachmentsAffected,
      attachmentDataLossAcknowledged:
        txResult.attachmentsAffected > 0 ? true : false,
      affectedAttachmentIds: txResult.affectedAttachmentIds,
      affectedAttachmentIdsOverflow: txResult.affectedAttachmentIdsOverflow,
      // From invalidateUserSessions — null when the post-tx call failed
      // (e.g., transient DB/Redis hiccup). UI should surface a banner when
      // cacheTombstoneFailures > 0 (#433 / S-N2 caveat).
      invalidatedSessions: invalidationResult?.sessions ?? null,
      invalidatedExtensionTokens: invalidationResult?.extensionTokens ?? null,
      invalidatedApiKeys: invalidationResult?.apiKeys ?? null,
      invalidatedMcpAccessTokens: invalidationResult?.mcpAccessTokens ?? null,
      invalidatedMcpRefreshTokens: invalidationResult?.mcpRefreshTokens ?? null,
      invalidatedDelegationSessions: invalidationResult?.delegationSessions ?? null,
      cacheTombstoneFailures: invalidationResult?.cacheTombstoneFailures ?? null,
    },
  });

  getLogger().info({ userId }, "vault.rotateKey.success");

  return NextResponse.json({
    success: true,
    keyVersion: newKeyVersion,
  });
}

export const POST = withRequestLog(handlePOST);
