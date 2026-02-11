import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { z } from "zod";

export const runtime = "nodejs";

const unlockSchema = z.object({
  authHash: z.string().length(64),
});

const unlockLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 5,
  useRedis: true,
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateKey = `rl:vault_unlock:${session.user.id}`;
  if (!(await unlockLimiter.check(rateKey))) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 }
    );
  }

  const body = await request.json();
  const parsed = unlockSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
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
      { error: "Vault not set up" },
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
