import { type NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
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
  VAULT_ROTATE_ATTACHMENT_CEK_MAX,
  BASE64_RE,
  CEK_WRAP_BASE64_MAX,
} from "@/lib/validations/common";
import { AUDIT_ACTION } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  applyVaultRotation,
  LegacyAttachmentsResidualError,
  AttachmentCekManifestMismatchError,
  LegacyAttachmentInconsistentVersionError,
  Mode2InvariantViolationError,
  RotationPostConditionError,
} from "@/lib/vault/rotate-key-server";

export const runtime = "nodejs";

const rotateLimiter = createRateLimiter({ windowMs: 15 * MS_PER_MINUTE, max: 3 });

const attachmentCekRewrapSchema = z.object({
  id: z.string().uuid(),
  // Strict standard base64 (RFC 4648 §4); the regex is anchored and
  // length-mod-4-aware so a malformed wrap never reaches `Buffer.from(_, "base64")`,
  // which silently drops invalid characters.
  cekEncrypted: z.string().min(1).max(CEK_WRAP_BASE64_MAX).regex(BASE64_RE),
  cekIv: hexIv,
  cekAuthTag: hexAuthTag,
  cekKeyVersion: z.number().int().min(1),
  cekWrapAadVersion: z.number().int().min(1),
});

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
  // Attachment CEK rewraps — re-wraps small CEKs rather than re-uploading file bodies.
  // Client must have migrated all mode-0 attachments to mode-2 before rotation.
  attachmentCekRewraps: z.array(attachmentCekRewrapSchema).max(VAULT_ROTATE_ATTACHMENT_CEK_MAX),
  // Client-reported count of mode-0 → mode-2 migrations performed this rotation cycle.
  legacyAttachmentsMigratedThisCycle: z.number().int().min(0).optional(),
});

/**
 * POST /api/vault/rotate-key
 * Rotate the vault's secret key wrapping.
 * The client re-encrypts the secret key with a new passphrase and bumps keyVersion.
 * All password entries, history entries, and mode-2 attachment CEKs are re-wrapped
 * atomically in a single interactive transaction. All EA grants with older
 * keyVersion are marked STALE.
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
    // Truncate verbose Zod errors — the schema has many potential issues
    // (entries array × many fields each) that would blow up the response.
    if (parsed.error.issues.length > 10) {
      return validationError({ errors: [`Validation failed with ${parsed.error.issues.length} errors`] });
    }
    return zodValidationError(parsed.error);
  }
  const payload = parsed.data;

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
    .update(payload.currentAuthHash + user.masterPasswordServerSalt)
    .digest("hex");

  const hashA = Buffer.from(computedHash, "hex");
  const hashB = Buffer.from(user.masterPasswordServerHash, "hex");
  if (hashA.length !== hashB.length || !timingSafeEqual(hashA, hashB)) {
    return errorResponse(API_ERROR.INVALID_PASSPHRASE, 401);
  }

  const newKeyVersion = user.keyVersion + 1;
  const newServerSalt = randomBytes(32).toString("hex");
  const newServerHash = createHash("sha256")
    .update(payload.newAuthHash + newServerSalt)
    .digest("hex");

  // Update vault wrapping, bump keyVersion, re-encrypt all entries and history,
  // rewrap all mode-2 attachment CEKs, clear orphan wrappings (recovery / EA / PRF),
  // and mark EA grants as STALE.
  // Interactive transaction with advisory lock prevents concurrent rotations for the same user.
  let txResult: Awaited<ReturnType<typeof applyVaultRotation>>;
  try {
    txResult = await withUserTenantRls(userId, async () =>
      prisma.$transaction(async (tx) => {
        // Advisory lock prevents concurrent key rotations for the same user (S-17 equivalent)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`;

        return applyVaultRotation(
          tx,
          userId,
          user.tenantId,
          user.keyVersion,
          newKeyVersion,
          newServerHash,
          newServerSalt,
          payload,
        );
      }, { timeout: 120_000 }),
    );
  } catch (e) {
    if (e instanceof LegacyAttachmentsResidualError) {
      return errorResponse(API_ERROR.LEGACY_ATTACHMENTS_RESIDUAL, 409);
    }
    if (e instanceof AttachmentCekManifestMismatchError) {
      return errorResponse(API_ERROR.ATTACHMENT_CEK_MANIFEST_MISMATCH, 409);
    }
    if (e instanceof LegacyAttachmentInconsistentVersionError) {
      return errorResponse(API_ERROR.ATTACHMENT_INCONSISTENT_VERSION, 409);
    }
    if (e instanceof Mode2InvariantViolationError) {
      // Server-side data corruption (mode-2 row with NULL cek_*). Surface
      // as 500 to match the post-condition error pattern; rotation must
      // not silently rewrap a half-written row.
      getLogger().error({ userId }, "vault.rotateKey.mode2InvariantViolation");
      return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
    }
    if (e instanceof RotationPostConditionError) {
      return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
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
  // McpAccessToken, McpRefreshToken, DelegationSession). Best-effort —
  // MUST remain OUTSIDE the rotation transaction because the helper opens
  // its own bypass-RLS transaction on the global prisma client and would
  // deadlock against the rotation's `pg_advisory_xact_lock` if nested.
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
      entriesRotated: payload.entries.length,
      historyEntriesRotated: payload.historyEntries.length,
      recoveryKeyInvalidated: txResult.recoveryKeyInvalidated,
      emergencyGrantsCleared: txResult.emergencyGrantsCleared,
      prfCredentialsCleared: txResult.prfCredentialsCleared,
      cekRewrapsAttempted: txResult.cekRewrapsAttempted,
      cekRewrapsSucceeded: txResult.cekRewrapsSucceeded,
      cekRewrapsFailed: txResult.cekRewrapsFailed,
      legacyAttachmentsMigratedClientReported: txResult.legacyAttachmentsMigratedClientReported,
      mode0Residual: txResult.mode0Residual,
      cekRewrappedAttachmentIds: txResult.cekRewrappedAttachmentIds,
      cekRewrappedAttachmentIdsOverflow: txResult.cekRewrappedAttachmentIdsOverflow,
      // From invalidateUserSessions — null when the post-tx call failed
      invalidationFailed: invalidationResult === null,
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
    rotationEffects: {
      recoveryKeyInvalidated: txResult.recoveryKeyInvalidated,
      emergencyGrantsCleared: txResult.emergencyGrantsCleared,
      prfCredentialsCleared: txResult.prfCredentialsCleared,
      cekRewrapsAttempted: txResult.cekRewrapsAttempted,
      cekRewrapsSucceeded: txResult.cekRewrapsSucceeded,
      cekRewrapsFailed: txResult.cekRewrapsFailed,
      invalidatedMcpAccessTokens: invalidationResult?.mcpAccessTokens ?? null,
      invalidatedMcpRefreshTokens: invalidationResult?.mcpRefreshTokens ?? null,
      cacheTombstoneFailures: invalidationResult?.cacheTombstoneFailures ?? null,
      invalidationFailed: invalidationResult === null,
    },
  });
}

export const POST = withRequestLog(handlePOST);
