import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * GET /api/vault/unlock/data
 * Returns the encrypted secret key and verification artifact.
 * The data is session-protected (SSO auth required).
 * The client cannot decrypt the secret key without the correct passphrase.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      vaultSetupAt: true,
      accountSalt: true,
      encryptedSecretKey: true,
      secretKeyIv: true,
      secretKeyAuthTag: true,
      keyVersion: true,
    },
  });

  if (!user?.vaultSetupAt) {
    return NextResponse.json(
      { error: "Vault not set up" },
      { status: 404 }
    );
  }

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
    accountSalt: user.accountSalt,
    encryptedSecretKey: user.encryptedSecretKey,
    secretKeyIv: user.secretKeyIv,
    secretKeyAuthTag: user.secretKeyAuthTag,
    keyVersion: user.keyVersion,
    verificationArtifact: vaultKey
      ? {
          ciphertext: vaultKey.verificationCiphertext,
          iv: vaultKey.verificationIv,
          authTag: vaultKey.verificationAuthTag,
        }
      : null,
  });
}
