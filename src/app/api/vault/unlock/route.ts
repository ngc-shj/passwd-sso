import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto-client";
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
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const rateKey = `rl:vault_unlock:${session.user.id}`;
  if (!(await unlockLimiter.check(rateKey))) {
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

  const user = await prisma.user.findUnique({
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
  });

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
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  // Reset failure counter on success
  await unlockLimiter.clear(rateKey);

  // Backfill passphrase verifier for existing users (transparent migration)
  if (parsed.data.verifierHash) {
    await prisma.user.updateMany({
      where: {
        id: session.user.id,
        passphraseVerifierHmac: null,
      },
      data: {
        passphraseVerifierHmac: hmacVerifier(parsed.data.verifierHash),
        passphraseVerifierVersion: VERIFIER_VERSION,
      },
    });
  }

  // Fetch verification artifact
  const vaultKey = await prisma.vaultKey.findUnique({
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
  });

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
