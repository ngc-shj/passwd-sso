import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const runtime = "nodejs";

const setupSchema = z.object({
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: z.string().length(24), // 12 bytes hex
  secretKeyAuthTag: z.string().length(32), // 16 bytes hex
  accountSalt: z.string().length(64), // 32 bytes hex
  authHash: z.string().length(64), // SHA-256 hex
  verificationArtifact: z.object({
    ciphertext: z.string().min(1),
    iv: z.string().length(24),
    authTag: z.string().length(32),
  }),
});

/**
 * POST /api/vault/setup
 * Initial vault setup: store encrypted secret key and auth hash.
 * Called once when the user first sets a passphrase.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Prevent re-setup
  const existingUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { vaultSetupAt: true },
  });
  if (existingUser?.vaultSetupAt) {
    return NextResponse.json(
      { error: "Vault already set up" },
      { status: 409 }
    );
  }

  const body = await request.json();
  const parsed = setupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
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

  return NextResponse.json({ success: true }, { status: 201 });
}
