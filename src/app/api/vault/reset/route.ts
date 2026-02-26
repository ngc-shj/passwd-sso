import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { withRequestLog } from "@/lib/with-request-log";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

const CONFIRMATION_TOKEN = "DELETE MY VAULT";

const resetSchema = z.object({
  confirmation: z.string(),
});

const resetLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
});

/**
 * POST /api/vault/reset
 * Last resort: delete all vault data when passphrase and recovery key are both lost.
 */
async function handlePOST(request: NextRequest) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const rateKey = `rl:vault_reset:${session.user.id}`;
  if (!(await resetLimiter.check(rateKey))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_JSON },
      { status: 400 },
    );
  }

  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR },
      { status: 400 },
    );
  }

  if (parsed.data.confirmation !== CONFIRMATION_TOKEN) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_RESET_CONFIRMATION_MISMATCH },
      { status: 400 },
    );
  }

  const userId = session.user.id;

  // Count data being deleted for audit metadata
  const [entryCount, attachmentCount] = await Promise.all([
    prisma.passwordEntry.count({ where: { userId } }),
    prisma.attachment.count({ where: { createdById: userId } }),
  ]);

  // Single transaction: delete all vault data
  await prisma.$transaction([
    // Attachments (bytea stored directly in DB, no external storage)
    // NOTE: If migrated to S3 in the future, add object deletion here
    prisma.attachment.deleteMany({ where: { createdById: userId } }),
    // Share links
    prisma.passwordShare.deleteMany({ where: { createdById: userId } }),
    // Password entries
    prisma.passwordEntry.deleteMany({ where: { userId } }),
    // Vault keys
    prisma.vaultKey.deleteMany({ where: { userId } }),
    // Tags (all entries deleted, tags are now orphaned)
    prisma.tag.deleteMany({ where: { userId } }),
    // Emergency access grants (revoke as owner)
    prisma.emergencyAccessGrant.updateMany({
      where: { ownerId: userId },
      data: { status: "REVOKED", revokedAt: new Date() },
    }),
    // Team E2E: delete all TeamMemberKey records for this user
    prisma.orgMemberKey.deleteMany({ where: { userId } }),
    // Team E2E: reset keyDistributed on all TeamMember records for this user
    prisma.orgMember.updateMany({
      where: { userId },
      data: { keyDistributed: false },
    }),
    // Null out vault + recovery + lockout + ECDH fields on User
    prisma.user.update({
      where: { id: userId },
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
  ]);

  const { ip, userAgent } = extractRequestMeta(request);
  logAudit({
    scope: "PERSONAL",
    action: "VAULT_RESET_EXECUTED",
    userId,
    metadata: {
      deletedEntries: entryCount,
      deletedAttachments: attachmentCount,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
