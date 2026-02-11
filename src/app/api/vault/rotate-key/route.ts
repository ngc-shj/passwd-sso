import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { markGrantsStaleForOwner } from "@/lib/emergency-access-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { z } from "zod";

export const runtime = "nodejs";

const rotateLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 3 });

const rotateKeySchema = z.object({
  // Current passphrase verification
  currentAuthHash: z.string().length(64),
  // New vault wrapping data
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: z.string().length(24),
  secretKeyAuthTag: z.string().length(32),
  accountSalt: z.string().length(64),
  newAuthHash: z.string().length(64),
  verificationArtifact: z.object({
    ciphertext: z.string().min(1),
    iv: z.string().length(24),
    authTag: z.string().length(32),
  }),
});

/**
 * POST /api/vault/rotate-key
 * Rotate the vault's secret key wrapping.
 * The client re-encrypts the secret key with a new passphrase and bumps keyVersion.
 * All EA grants with older keyVersion are marked STALE.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await rotateLimiter.check(`rl:vault_rotate:${session.user.id}`))) {
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

  const parsed = rotateKeySchema.safeParse(body);
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
      keyVersion: true,
    },
  });

  if (!user?.vaultSetupAt) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_NOT_SETUP },
      { status: 404 }
    );
  }

  // Verify current passphrase
  const computedHash = createHash("sha256")
    .update(parsed.data.currentAuthHash + user.masterPasswordServerSalt)
    .digest("hex");

  if (computedHash !== user.masterPasswordServerHash) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_PASSPHRASE },
      { status: 401 }
    );
  }

  const newKeyVersion = user.keyVersion + 1;
  const newServerSalt = randomBytes(32).toString("hex");
  const newServerHash = createHash("sha256")
    .update(parsed.data.newAuthHash + newServerSalt)
    .digest("hex");

  // Update vault wrapping and bump keyVersion in a transaction
  await prisma.$transaction([
    prisma.user.update({
      where: { id: session.user.id },
      data: {
        encryptedSecretKey: parsed.data.encryptedSecretKey,
        secretKeyIv: parsed.data.secretKeyIv,
        secretKeyAuthTag: parsed.data.secretKeyAuthTag,
        accountSalt: parsed.data.accountSalt,
        masterPasswordServerHash: newServerHash,
        masterPasswordServerSalt: newServerSalt,
        keyVersion: newKeyVersion,
      },
    }),
    prisma.vaultKey.create({
      data: {
        userId: session.user.id,
        version: newKeyVersion,
        verificationCiphertext: parsed.data.verificationArtifact.ciphertext,
        verificationIv: parsed.data.verificationArtifact.iv,
        verificationAuthTag: parsed.data.verificationArtifact.authTag,
      },
    }),
  ]);

  // Mark EA grants as STALE (best-effort, outside transaction)
  await markGrantsStaleForOwner(session.user.id, newKeyVersion).catch(() => {});

  return NextResponse.json({
    success: true,
    keyVersion: newKeyVersion,
  });
}
