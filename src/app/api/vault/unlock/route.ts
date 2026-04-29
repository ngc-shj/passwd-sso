import { type NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import { checkLockout, recordFailure, resetLockout } from "@/lib/auth/policy/account-lockout";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { errorResponse, rateLimited, unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { hexHash } from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const unlockSchema = z.object({
  authHash: hexHash,
  verifierHash: hexHash.optional(),
});

const unlockLimiter = createRateLimiter({
  windowMs: 5 * MS_PER_MINUTE,
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
    return unauthorized();
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
  const rl = await unlockLimiter.check(rateKey);
  if (!rl.allowed) {
    getLogger().warn({ userId: session.user.id }, "vault.unlock.rateLimited");
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(request, unlockSchema);
  if (!result.ok) return result.response;

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
        passphraseVerifierHmac: true,
        passphraseVerifierVersion: true,
      },
    }),
  );

  if (!user?.vaultSetupAt || !user.masterPasswordServerHash || !user.masterPasswordServerSalt) {
    return errorResponse(API_ERROR.VAULT_NOT_SETUP, 404);
  }

  // Verify: SHA-256(authHash + serverSalt) === stored serverHash
  const computedHash = createHash("sha256")
    .update(result.data.authHash + user.masterPasswordServerSalt)
    .digest("hex");

  const hashA = Buffer.from(computedHash, "hex");
  const hashB = Buffer.from(user.masterPasswordServerHash, "hex");
  if (hashA.length !== hashB.length || !timingSafeEqual(hashA, hashB)) {
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

  // Backfill/upgrade passphrase verifier: on null or stale pepper version
  const verifierHash = result.data.verifierHash;
  if (verifierHash && (
    user.passphraseVerifierHmac === null ||
    user.passphraseVerifierVersion !== VERIFIER_VERSION
  )) {
    await withUserTenantRls(session.user.id, async () =>
      prisma.user.updateMany({
        where: { id: session.user.id },
        data: {
          passphraseVerifierHmac: hmacVerifier(verifierHash),
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
