import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier, verifyPassphraseVerifier as verifyHmac } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, zodValidationError } from "@/lib/api-response";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { hexIv, hexAuthTag, hexSalt, hexHash } from "@/lib/validations/common";

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

const verifyLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
});
const resetLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
});

/**
 * POST /api/vault/recovery-key/recover
 * Two-step recovery: verify → reset.
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

  const userId = session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_JSON },
      { status: 400 },
    );
  }

  // Determine step
  const stepCheck = z.object({ step: z.enum(["verify", "reset"]) }).safeParse(body);
  if (!stepCheck.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR },
      { status: 400 },
    );
  }

  // Per-step rate limiting
  if (stepCheck.data.step === "verify") {
    const rl = await verifyLimiter.check(`rl:recovery_verify:${userId}`);
    if (!rl.allowed) return rateLimited(rl.retryAfterMs);
    return handleVerify(body, userId);
  } else {
    const rl = await resetLimiter.check(`rl:recovery_reset:${userId}`);
    if (!rl.allowed) return rateLimited(rl.retryAfterMs);
    const response = await handleReset(body, userId, request);
    // Clear reset limiter on success
    if (response.status === 200) {
      await resetLimiter.clear(`rl:recovery_reset:${userId}`);
    }
    return response;
  }
}

async function handleVerify(body: unknown, userId: string) {
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }

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
  if (!verifyHmac(parsed.data.verifierHash, user.recoveryVerifierHmac)) {
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

async function handleReset(body: unknown, userId: string, request: NextRequest) {
  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }

  const data = parsed.data;

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

  const { ip, userAgent } = extractRequestMeta(request);
  await logAuditAsync({
    scope: "PERSONAL",
    action: "RECOVERY_PASSPHRASE_RESET",
    userId,
    metadata: {
      keyVersion: user.keyVersion,
      recoveryKeyRegenerated: true,
      lockoutReset: true,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
