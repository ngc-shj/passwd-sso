import { type NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { auth } from "@/auth";
import { assertOrigin } from "@/lib/auth/csrf";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { VERIFIER_VERSION } from "@/lib/crypto/crypto-client";
import { prisma } from "@/lib/prisma";
import { markGrantsStaleForOwner } from "@/lib/emergency-access/emergency-access-server";
import { revokeAllDelegationSessions } from "@/lib/auth/delegation";
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
});

/**
 * POST /api/vault/rotate-key
 * Rotate the vault's secret key wrapping.
 * The client re-encrypts the secret key with a new passphrase and bumps keyVersion.
 * All password entries and history entries are re-encrypted atomically in a single
 * interactive transaction. All EA grants with older keyVersion are marked STALE.
 */
async function handlePOST(request: NextRequest) {
  const originError = assertOrigin(request);
  if (originError) return originError;

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

  // Update vault wrapping, bump keyVersion, re-encrypt all entries, and mark EA grants as STALE.
  // Interactive transaction with advisory lock prevents concurrent rotations for the same user.
  try {
    await withUserTenantRls(userId, async () =>
      prisma.$transaction(async (tx) => {
        // Advisory lock prevents concurrent key rotations for the same user (S-17 equivalent)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`;

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

        // Update user vault wrapping keys and ECDH private key
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
      }, { timeout: 120_000 }),
    );
  } catch (e) {
    if (e instanceof Error && e.message === "ENTRY_COUNT_MISMATCH") {
      return errorResponse(API_ERROR.ENTRY_COUNT_MISMATCH, 400);
    }
    if (e instanceof Error && e.message === "HISTORY_COUNT_MISMATCH") {
      return errorResponse(API_ERROR.ENTRY_COUNT_MISMATCH, 400);
    }
    throw e;
  }

  // Mark EA grants as STALE (best-effort, outside transaction)
  await withUserTenantRls(userId, async () =>
    markGrantsStaleForOwner(userId, newKeyVersion).catch(() => {}),
  );

  // Revoke all delegation sessions (key rotation invalidates delegated plaintext)
  await revokeAllDelegationSessions(userId, user.tenantId, "KEY_ROTATION").catch(() => {});

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
    },
  });

  getLogger().info({ userId }, "vault.rotateKey.success");

  return NextResponse.json({
    success: true,
    keyVersion: newKeyVersion,
  });
}

export const POST = withRequestLog(handlePOST);
