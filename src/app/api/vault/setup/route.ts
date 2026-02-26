import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto-client";
import { withRequestLog } from "@/lib/with-request-log";
import { getLogger } from "@/lib/logger";
import { z } from "zod";

export const runtime = "nodejs";

const setupLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 5 });

const setupSchema = z.object({
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: z.string().regex(/^[0-9a-f]{24}$/), // 12 bytes hex
  secretKeyAuthTag: z.string().regex(/^[0-9a-f]{32}$/), // 16 bytes hex
  accountSalt: z.string().regex(/^[0-9a-f]{64}$/), // 32 bytes hex
  authHash: z.string().regex(/^[0-9a-f]{64}$/), // SHA-256 hex
  verifierHash: z.string().regex(/^[0-9a-f]{64}$/), // passphrase verifier
  verificationArtifact: z.object({
    ciphertext: z.string().min(1),
    iv: z.string().regex(/^[0-9a-f]{24}$/),
    authTag: z.string().regex(/^[0-9a-f]{32}$/),
  }),
  // ECDH key pair for team E2E encryption
  ecdhPublicKey: z.string().min(1),
  encryptedEcdhPrivateKey: z.string().min(1),
  ecdhPrivateKeyIv: z.string().regex(/^[0-9a-f]{24}$/),
  ecdhPrivateKeyAuthTag: z.string().regex(/^[0-9a-f]{32}$/),
});

/**
 * POST /api/vault/setup
 * Initial vault setup: store encrypted secret key and auth hash.
 * Called once when the user first sets a passphrase.
 */
async function handlePOST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await setupLimiter.check(`rl:vault_setup:${session.user.id}`))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 }
    );
  }

  // Prevent re-setup
  const existingUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { vaultSetupAt: true },
  });
  if (existingUser?.vaultSetupAt) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_ALREADY_SETUP },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = setupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;

  // Hash authHash with a server-side salt for storage
  // serverHash = SHA-256(authHash + serverSalt)
  const serverSalt = randomBytes(32).toString("hex");
  const serverHash = createHash("sha256")
    .update(data.authHash + serverSalt)
    .digest("hex");

  await prisma.$transaction([
    prisma.user.update({
      where: { id: session.user.id },
      data: {
        vaultSetupAt: new Date(),
        accountSalt: data.accountSalt,
        encryptedSecretKey: data.encryptedSecretKey,
        secretKeyIv: data.secretKeyIv,
        secretKeyAuthTag: data.secretKeyAuthTag,
        masterPasswordServerHash: serverHash,
        masterPasswordServerSalt: serverSalt,
        keyVersion: 1,
        passphraseVerifierHmac: hmacVerifier(data.verifierHash),
        passphraseVerifierVersion: VERIFIER_VERSION,
        // ECDH key pair for team E2E encryption
        ecdhPublicKey: data.ecdhPublicKey,
        encryptedEcdhPrivateKey: data.encryptedEcdhPrivateKey,
        ecdhPrivateKeyIv: data.ecdhPrivateKeyIv,
        ecdhPrivateKeyAuthTag: data.ecdhPrivateKeyAuthTag,
      },
    }),
    prisma.vaultKey.create({
      data: {
        userId: session.user.id,
        version: 1,
        verificationCiphertext: data.verificationArtifact.ciphertext,
        verificationIv: data.verificationArtifact.iv,
        verificationAuthTag: data.verificationArtifact.authTag,
      },
    }),
  ]);

  getLogger().info({ userId: session.user.id }, "vault.setup.success");

  return NextResponse.json({ success: true }, { status: 201 });
}

export const POST = withRequestLog(handlePOST);
