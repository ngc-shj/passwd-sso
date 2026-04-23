import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier, verifyPassphraseVerifier } from "@/lib/crypto/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto/crypto-client";
import { assertOrigin } from "@/lib/auth/csrf";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { hexIv, hexAuthTag, hexSalt, hexHash } from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const generateSchema = z.object({
  currentVerifierHash: hexHash,
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: hexIv,
  secretKeyAuthTag: hexAuthTag,
  hkdfSalt: hexSalt,
  verifierHash: hexHash,
});

const generateLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 3,
});

/**
 * POST /api/vault/recovery-key/generate
 * Store client-generated Recovery Key encrypted data.
 * Requires passphrase re-confirmation (anti-session-hijacking).
 */
async function handlePOST(request: NextRequest) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const rateKey = `rl:recovery_key_gen:${session.user.id}`;
  const rl = await generateLimiter.check(rateKey);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(request, generateSchema);
  if (!result.ok) return result.response;
  const data = result.data;

  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        vaultSetupAt: true,
        passphraseVerifierHmac: true,
        passphraseVerifierVersion: true,
        recoveryKeySetAt: true,
        keyVersion: true,
      },
    }),
  );

  if (!user?.vaultSetupAt) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_NOT_SETUP },
      { status: 404 },
    );
  }

  if (!user.passphraseVerifierHmac) {
    return NextResponse.json(
      { error: API_ERROR.VERIFIER_NOT_SET },
      { status: 409 },
    );
  }

  if (user.passphraseVerifierVersion !== VERIFIER_VERSION) {
    return NextResponse.json(
      { error: API_ERROR.VERIFIER_VERSION_UNSUPPORTED },
      { status: 409 },
    );
  }

  // Verify current passphrase via verifier (anti-session-hijacking)
  if (
    !verifyPassphraseVerifier(
      data.currentVerifierHash,
      user.passphraseVerifierHmac,
    )
  ) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_PASSPHRASE },
      { status: 401 },
    );
  }

  // Store recovery key data
  await withUserTenantRls(session.user.id, async () =>
    prisma.user.update({
      where: { id: session.user.id },
      data: {
        recoveryEncryptedSecretKey: data.encryptedSecretKey,
        recoverySecretKeyIv: data.secretKeyIv,
        recoverySecretKeyAuthTag: data.secretKeyAuthTag,
        recoveryHkdfSalt: data.hkdfSalt,
        recoveryVerifierHmac: hmacVerifier(data.verifierHash),
        recoveryKeySetAt: new Date(),
      },
    }),
  );

  // Audit log
  const isRegeneration = !!user.recoveryKeySetAt;
  await logAuditAsync({
    ...personalAuditBase(request, session.user.id),
    action: isRegeneration ? AUDIT_ACTION.RECOVERY_KEY_REGENERATED : AUDIT_ACTION.RECOVERY_KEY_CREATED,
    metadata: { keyVersion: user.keyVersion },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
