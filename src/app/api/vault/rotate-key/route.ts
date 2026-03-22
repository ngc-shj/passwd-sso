import { type NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { auth } from "@/auth";
import { assertOrigin } from "@/lib/csrf";
import { hmacVerifier } from "@/lib/crypto-server";
import { VERIFIER_VERSION } from "@/lib/crypto-client";
import { prisma } from "@/lib/prisma";
import { markGrantsStaleForOwner } from "@/lib/emergency-access-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { getLogger } from "@/lib/logger";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { z } from "zod";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import {
  hexIv,
  hexAuthTag,
  hexSalt,
  hexHash,
  encryptedFieldSchema,
  VAULT_ROTATE_ENTRIES_MAX,
  VAULT_ROTATE_HISTORY_MAX,
  ECDH_PRIVATE_KEY_CIPHERTEXT_MAX,
} from "@/lib/validations/common";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants";

export const runtime = "nodejs";

const rotateLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 3 });

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
  verificationArtifact: z.object({
    ciphertext: z.string().min(1),
    iv: hexIv,
    authTag: hexAuthTag,
  }),
  // Entry re-encryption payload
  entries: z.array(z.object({
    id: z.string().uuid(),
    encryptedBlob: encryptedFieldSchema,
    encryptedOverview: encryptedFieldSchema,
    aadVersion: z.number().int().min(0).default(0),
  })).max(VAULT_ROTATE_ENTRIES_MAX),
  historyEntries: z.array(z.object({
    id: z.string().uuid(),
    encryptedBlob: encryptedFieldSchema,
    aadVersion: z.number().int().min(0).default(0),
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

  if (!(await rotateLimiter.check(`rl:vault_rotate:${session.user.id}`)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }

  const parsed = rotateKeySchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error.flatten());
  }

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
    .update(parsed.data.currentAuthHash + user.masterPasswordServerSalt)
    .digest("hex");

  const hashA = Buffer.from(computedHash, "hex");
  const hashB = Buffer.from(user.masterPasswordServerHash, "hex");
  if (hashA.length !== hashB.length || !timingSafeEqual(hashA, hashB)) {
    return errorResponse(API_ERROR.INVALID_PASSPHRASE, 401);
  }

  const newKeyVersion = user.keyVersion + 1;
  const newServerSalt = randomBytes(32).toString("hex");
  const newServerHash = createHash("sha256")
    .update(parsed.data.newAuthHash + newServerSalt)
    .digest("hex");

  const {
    entries,
    historyEntries,
    encryptedEcdhPrivateKey,
    ecdhPrivateKeyIv,
    ecdhPrivateKeyAuthTag,
  } = parsed.data;

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
                encryptedBlob: entry.encryptedBlob.ciphertext,
                blobIv: entry.encryptedBlob.iv,
                blobAuthTag: entry.encryptedBlob.authTag,
                encryptedOverview: entry.encryptedOverview.ciphertext,
                overviewIv: entry.encryptedOverview.iv,
                overviewAuthTag: entry.encryptedOverview.authTag,
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
                encryptedBlob: historyEntry.encryptedBlob.ciphertext,
                blobIv: historyEntry.encryptedBlob.iv,
                blobAuthTag: historyEntry.encryptedBlob.authTag,
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
            encryptedSecretKey: parsed.data.encryptedSecretKey,
            secretKeyIv: parsed.data.secretKeyIv,
            secretKeyAuthTag: parsed.data.secretKeyAuthTag,
            accountSalt: parsed.data.accountSalt,
            masterPasswordServerHash: newServerHash,
            masterPasswordServerSalt: newServerSalt,
            keyVersion: newKeyVersion,
            // Sync verifier with new accountSalt to keep change-passphrase working
            ...(parsed.data.newVerifierHash
              ? {
                  passphraseVerifierHmac: hmacVerifier(parsed.data.newVerifierHash),
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
            verificationCiphertext: parsed.data.verificationArtifact.ciphertext,
            verificationIv: parsed.data.verificationArtifact.iv,
            verificationAuthTag: parsed.data.verificationArtifact.authTag,
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

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.VAULT_KEY_ROTATION,
    userId,
    targetType: "User",
    targetId: userId,
    metadata: {
      fromVersion: user.keyVersion,
      toVersion: newKeyVersion,
      entriesRotated: entries.length,
      historyEntriesRotated: historyEntries.length,
    },
    ...extractRequestMeta(request),
  });

  getLogger().info({ userId }, "vault.rotateKey.success");

  return NextResponse.json({
    success: true,
    keyVersion: newKeyVersion,
  });
}

export const POST = withRequestLog(handlePOST);
