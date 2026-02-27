import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier, verifyPassphraseVerifier as verifyHmac } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { withRequestLog } from "@/lib/with-request-log";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";

export const runtime = "nodejs";

const HEX64 = z.string().regex(/^[0-9a-f]{64}$/);
const HEX24 = z.string().regex(/^[0-9a-f]{24}$/);
const HEX32 = z.string().regex(/^[0-9a-f]{32}$/);

const verifySchema = z.object({
  step: z.literal("verify"),
  verifierHash: HEX64,
});

const resetSchema = z.object({
  step: z.literal("reset"),
  verifierHash: HEX64,
  // New passphrase-wrapped data
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: HEX24,
  secretKeyAuthTag: HEX32,
  accountSalt: HEX64,
  newVerifierHash: HEX64,
  // Re-wrapped recovery key data
  recoveryEncryptedSecretKey: z.string().min(1),
  recoverySecretKeyIv: HEX24,
  recoverySecretKeyAuthTag: HEX32,
  recoveryHkdfSalt: HEX64,
  recoveryVerifierHash: HEX64,
});

const recoverLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
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

  const rateKey = `rl:recovery_key_recover:${session.user.id}`;
  if (!(await recoverLimiter.check(rateKey))) {
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

  // Determine step
  const stepCheck = z.object({ step: z.enum(["verify", "reset"]) }).safeParse(body);
  if (!stepCheck.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR },
      { status: 400 },
    );
  }

  if (stepCheck.data.step === "verify") {
    return handleVerify(body, session.user.id);
  } else {
    return handleReset(body, session.user.id, request);
  }
}

async function handleVerify(body: unknown, userId: string) {
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
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
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
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
  logAudit({
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
