import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto-client";
import { withRequestLog } from "@/lib/with-request-log";
import { getLogger } from "@/lib/logger";
import { checkLockout, recordFailure, resetLockout } from "@/lib/account-lockout";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";

export const runtime = "nodejs";

const unlockSchema = z.object({
  authHash: z.string().regex(/^[0-9a-f]{64}$/),
  verifierHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const unlockLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 5,
});

/**
 * POST /api/vault/unlock
 * Verify the user's passphrase via authHash comparison.
 * On success, return the encrypted secret key + verification artifact
 * so the client can decrypt the secret key and verify locally.
 */
async function handlePOST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Lockout check — before rate limiter and passphrase verification
  const lockoutStatus = await checkLockout(session.user.id);
  if (lockoutStatus.locked) {
    return NextResponse.json(
      { error: API_ERROR.ACCOUNT_LOCKED, lockedUntil: lockoutStatus.lockedUntil },
      { status: 403 },
    );
  }

  const rateKey = `rl:vault_unlock:${session.user.id}`;
  if (!(await unlockLimiter.check(rateKey))) {
    getLogger().warn({ userId: session.user.id }, "vault.unlock.rateLimited");
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = unlockSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        vaultSetupAt: true,
        masterPasswordServerHash: true,
        masterPasswordServerSalt: true,
        encryptedSecretKey: true,
        secretKeyIv: true,
        secretKeyAuthTag: true,
        accountSalt: true,
        keyVersion: true,
      },
    }),
  );

  if (!user?.vaultSetupAt) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_NOT_SETUP },
      { status: 404 }
    );
  }

  // Verify: SHA-256(authHash + serverSalt) === stored serverHash
  const computedHash = createHash("sha256")
    .update(parsed.data.authHash + user.masterPasswordServerSalt)
    .digest("hex");

  if (computedHash !== user.masterPasswordServerHash) {
    const failResult = await recordFailure(session.user.id, request);
    if (failResult === null) {
      // lock_timeout: counter NOT incremented, temporary contention
      // Client should retry with Retry-After + random jitter (0-2s)
      const res = NextResponse.json(
        { error: API_ERROR.SERVICE_UNAVAILABLE },
        { status: 503 },
      );
      res.headers.set("Retry-After", "1");
      return res;
    }
    if (failResult.locked) {
      return NextResponse.json(
        { error: API_ERROR.ACCOUNT_LOCKED, lockedUntil: failResult.lockedUntil },
        { status: 403 },
      );
    }
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  // Reset lockout + rate limiter on success
  // resetLockout swallows errors internally, but wrap in try/catch for defense-in-depth
  try {
    await resetLockout(session.user.id);
  } catch (err) {
    getLogger().error({ err, userId: session.user.id }, "vault.unlock.resetLockout.error");
  }
  await unlockLimiter.clear(rateKey);

  // Backfill passphrase verifier for existing users (transparent migration)
  if (parsed.data.verifierHash) {
    await withUserTenantRls(session.user.id, async () =>
      prisma.user.updateMany({
        where: {
          id: session.user.id,
          passphraseVerifierHmac: null,
        },
        data: {
          passphraseVerifierHmac: hmacVerifier(parsed.data.verifierHash),
          passphraseVerifierVersion: VERIFIER_VERSION,
        },
      }),
    );
  }

  // Fetch verification artifact
  const vaultKey = await withUserTenantRls(session.user.id, async () =>
    prisma.vaultKey.findUnique({
      where: {
        userId_version: {
          userId: session.user.id,
          version: user.keyVersion,
        },
      },
      select: {
        verificationCiphertext: true,
        verificationIv: true,
        verificationAuthTag: true,
      },
    }),
  );

  getLogger().info({ userId: session.user.id }, "vault.unlock.success");

  return NextResponse.json({
    valid: true,
    encryptedSecretKey: user.encryptedSecretKey,
    secretKeyIv: user.secretKeyIv,
    secretKeyAuthTag: user.secretKeyAuthTag,
    accountSalt: user.accountSalt,
    verificationArtifact: vaultKey
      ? {
          ciphertext: vaultKey.verificationCiphertext,
          iv: vaultKey.verificationIv,
          authTag: vaultKey.verificationAuthTag,
        }
      : null,
    keyVersion: user.keyVersion,
  });
}

export const POST = withRequestLog(handlePOST);
