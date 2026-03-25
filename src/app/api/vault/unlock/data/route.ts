import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { checkAuth } from "@/lib/check-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { rateLimited } from "@/lib/api-response";

export const runtime = "nodejs";

// Higher limit than vault/unlock — this endpoint only returns encrypted data
// and cannot be used for brute-force (passphrase verification is separate).
// 120 req/5min accounts for ~40 E2E unlock calls + CI retries (×2) + headroom.
const vaultUnlockDataLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 120 });

/**
 * GET /api/vault/unlock/data
 * Returns the encrypted secret key and verification artifact.
 * Accepts Auth.js session or extension token (scope: vault:unlock-data).
 * The client cannot decrypt the secret key without the correct passphrase.
 */
async function handleGET(req: NextRequest) {
  const authResult = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA });
  if (!authResult.ok) return authResult.response;
  const userId = authResult.auth.userId;

  const rl = await vaultUnlockDataLimiter.check(`rl:vault_unlock_data:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const user = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        vaultSetupAt: true,
        accountSalt: true,
        encryptedSecretKey: true,
        secretKeyIv: true,
        secretKeyAuthTag: true,
        keyVersion: true,
        kdfType: true,
        kdfIterations: true,
        kdfMemory: true,
        kdfParallelism: true,
        passphraseVerifierHmac: true,
        tenant: { select: { vaultAutoLockMinutes: true } },
        // ECDH fields for team E2E
        ecdhPublicKey: true,
        encryptedEcdhPrivateKey: true,
        ecdhPrivateKeyIv: true,
        ecdhPrivateKeyAuthTag: true,
      },
    }),
  );

  if (!user?.vaultSetupAt) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_NOT_SETUP },
      { status: 404 },
    );
  }

  const vaultKey = await withUserTenantRls(userId, async () =>
    prisma.vaultKey.findUnique({
      where: {
        userId_version: {
          userId,
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

  // ECDH fields for team E2E (available for both session and extension tokens)
  const ecdhFields = "ecdhPublicKey" in user
    ? {
        ecdhPublicKey: user.ecdhPublicKey,
        encryptedEcdhPrivateKey: user.encryptedEcdhPrivateKey,
        ecdhPrivateKeyIv: user.ecdhPrivateKeyIv,
        ecdhPrivateKeyAuthTag: user.ecdhPrivateKeyAuthTag,
      }
    : {};

  return NextResponse.json({
    userId,
    accountSalt: user.accountSalt,
    encryptedSecretKey: user.encryptedSecretKey,
    secretKeyIv: user.secretKeyIv,
    secretKeyAuthTag: user.secretKeyAuthTag,
    keyVersion: user.keyVersion,
    kdfType: (user as Record<string, unknown>).kdfType,
    kdfIterations: (user as Record<string, unknown>).kdfIterations,
    kdfMemory: (user as Record<string, unknown>).kdfMemory ?? null,
    kdfParallelism: (user as Record<string, unknown>).kdfParallelism ?? null,
    hasVerifier: !!user.passphraseVerifierHmac,
    verificationArtifact: vaultKey
      ? {
          ciphertext: vaultKey.verificationCiphertext,
          iv: vaultKey.verificationIv,
          authTag: vaultKey.verificationAuthTag,
        }
      : null,
    ...ecdhFields,
    vaultAutoLockMinutes: user.tenant?.vaultAutoLockMinutes ?? null,
  });
}

export const GET = withRequestLog(handleGET);
