import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { hmacVerifier, verifyPassphraseVerifier as verifyHmac } from "@/lib/crypto/crypto-server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { hexIv, hexAuthTag, hexSalt, hexHash } from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const verifySchema = z.object({
  step: z.literal("verify"),
  verifierHash: hexHash,
});

const resetSchema = z.object({
  step: z.literal("reset"),
  verifierHash: hexHash,
  // New passphrase-wrapped data
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: hexIv,
  secretKeyAuthTag: hexAuthTag,
  accountSalt: hexSalt,
  newVerifierHash: hexHash,
  // Re-wrapped recovery key data
  recoveryEncryptedSecretKey: z.string().min(1),
  recoverySecretKeyIv: hexIv,
  recoverySecretKeyAuthTag: hexAuthTag,
  recoveryHkdfSalt: hexSalt,
  recoveryVerifierHash: hexHash,
});

const recoverSchema = z.discriminatedUnion("step", [verifySchema, resetSchema]);

const verifyLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 5,
});
const resetLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 3,
});

/**
 * POST /api/vault/recovery-key/recover
 * Two-step recovery: verify → reset.
 */
async function handlePOST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const userId = session.user.id;

  const result = await parseBody(request, recoverSchema);
  if (!result.ok) return result.response;

  // Per-step rate limiting
  if (result.data.step === "verify") {
    const rl = await verifyLimiter.check(`rl:recovery_verify:${userId}`);
    if (!rl.allowed) return rateLimited(rl.retryAfterMs);
    return handleVerify(result.data, userId);
  } else {
    const rl = await resetLimiter.check(`rl:recovery_reset:${userId}`);
    if (!rl.allowed) return rateLimited(rl.retryAfterMs);
    const response = await handleReset(result.data, userId, request);
    // Clear reset limiter on success
    if (response.status === 200) {
      await resetLimiter.clear(`rl:recovery_reset:${userId}`);
    }
    return response;
  }
}

async function handleVerify(data: z.infer<typeof verifySchema>, userId: string) {
  const user = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        recoveryVerifierHmac: true,
        recoveryEncryptedSecretKey: true,
        recoverySecretKeyIv: true,
        recoverySecretKeyAuthTag: true,
        recoveryHkdfSalt: true,
        accountSalt: true,
        keyVersion: true,
      },
    }),
  );

  if (!user?.recoveryVerifierHmac) {
    return NextResponse.json(
      { error: API_ERROR.RECOVERY_KEY_NOT_SET },
      { status: 404 },
    );
  }

  // Verify recovery key via HMAC comparison
  if (!verifyHmac(data.verifierHash, user.recoveryVerifierHmac)) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_RECOVERY_KEY },
      { status: 401 },
    );
  }

  // Return encrypted data for client-side decryption (never return HMAC)
  return NextResponse.json({
    verified: true,
    encryptedSecretKey: user.recoveryEncryptedSecretKey,
    iv: user.recoverySecretKeyIv,
    authTag: user.recoverySecretKeyAuthTag,
    hkdfSalt: user.recoveryHkdfSalt,
    accountSalt: user.accountSalt,
    keyVersion: user.keyVersion,
  });
}

async function handleReset(data: z.infer<typeof resetSchema>, userId: string, request: NextRequest) {
  // Re-verify recovery key (verifierHash serves as implicit token)
  const user = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        recoveryVerifierHmac: true,
        keyVersion: true,
      },
    }),
  );

  if (!user?.recoveryVerifierHmac) {
    return NextResponse.json(
      { error: API_ERROR.RECOVERY_KEY_NOT_SET },
      { status: 404 },
    );
  }

  if (!verifyHmac(data.verifierHash, user.recoveryVerifierHmac)) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_RECOVERY_KEY },
      { status: 401 },
    );
  }

  // Update passphrase + recovery key data in a single transaction
  await withUserTenantRls(userId, async () =>
    prisma.user.update({
      where: { id: userId },
      data: {
        // New passphrase-wrapped secret key
        encryptedSecretKey: data.encryptedSecretKey,
        secretKeyIv: data.secretKeyIv,
        secretKeyAuthTag: data.secretKeyAuthTag,
        accountSalt: data.accountSalt,
        passphraseVerifierHmac: hmacVerifier(data.newVerifierHash),
        // Re-wrapped recovery key data
        recoveryEncryptedSecretKey: data.recoveryEncryptedSecretKey,
        recoverySecretKeyIv: data.recoverySecretKeyIv,
        recoverySecretKeyAuthTag: data.recoverySecretKeyAuthTag,
        recoveryHkdfSalt: data.recoveryHkdfSalt,
        recoveryVerifierHmac: hmacVerifier(data.recoveryVerifierHash),
        recoveryKeySetAt: new Date(),
        // Reset lockout
        failedUnlockAttempts: 0,
        lastFailedUnlockAt: null,
        accountLockedUntil: null,
      },
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(request, userId),
    action: AUDIT_ACTION.RECOVERY_PASSPHRASE_RESET,
    metadata: {
      keyVersion: user.keyVersion,
      recoveryKeyRegenerated: true,
      lockoutReset: true,
    },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
