import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { authOrToken } from "@/lib/auth-or-token";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants";

export const runtime = "nodejs";

/**
 * GET /api/vault/unlock/data
 * Returns the encrypted secret key and verification artifact.
 * Accepts Auth.js session or extension token (scope: vault:unlock-data).
 * The client cannot decrypt the secret key without the correct passphrase.
 */
export async function GET(req: NextRequest) {
  const authResult = await authOrToken(
    req,
    EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA,
  );
  if (authResult?.type === "scope_insufficient") {
    return NextResponse.json(
      { error: API_ERROR.EXTENSION_TOKEN_SCOPE_INSUFFICIENT },
      { status: 403 },
    );
  }
  if (!authResult) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }
  const userId = authResult.userId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      vaultSetupAt: true,
      accountSalt: true,
      encryptedSecretKey: true,
      secretKeyIv: true,
      secretKeyAuthTag: true,
      keyVersion: true,
      passphraseVerifierHmac: true,
    },
  });

  if (!user?.vaultSetupAt) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_NOT_SETUP },
      { status: 404 },
    );
  }

  const vaultKey = await prisma.vaultKey.findUnique({
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
  });

  return NextResponse.json({
    userId,
    accountSalt: user.accountSalt,
    encryptedSecretKey: user.encryptedSecretKey,
    secretKeyIv: user.secretKeyIv,
    secretKeyAuthTag: user.secretKeyAuthTag,
    keyVersion: user.keyVersion,
    hasVerifier: !!user.passphraseVerifierHmac,
    verificationArtifact: vaultKey
      ? {
          ciphertext: vaultKey.verificationCiphertext,
          iv: vaultKey.verificationIv,
          authTag: vaultKey.verificationAuthTag,
        }
      : null,
  });
}
