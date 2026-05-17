import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { hmacVerifier, verifyPassphraseVerifier } from "@/lib/crypto/crypto-server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import { logAuditAsync, personalAuditBase, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
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
  failClosedOnRedisError: true,
});

/**
 * POST /api/vault/recovery-key/generate
 * Store client-generated Recovery Key encrypted data.
 * Requires passphrase re-confirmation (anti-session-hijacking).
 */
async function handlePOST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const blocked = await checkRateLimitOrFail({
    req: request,
    limiter: generateLimiter,
    key: `rl:recovery_key_gen:${session.user.id}`,
    scope: "vault.recovery_generate",
    userId: session.user.id,
  });
  if (blocked) return blocked;

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
        recoveryKeyInvalidatedAt: true,
        keyVersion: true,
        tenantId: true,
      },
    }),
  );

  if (!user?.vaultSetupAt) {
    return errorResponse(API_ERROR.VAULT_NOT_SETUP);
  }

  if (!user.passphraseVerifierHmac) {
    return errorResponse(API_ERROR.VERIFIER_NOT_SET);
  }

  // Verify current passphrase via verifier (dual-version: verifies against stored pepper version)
  const verifyResult = verifyPassphraseVerifier(
    data.currentVerifierHash,
    user.passphraseVerifierHmac,
    user.passphraseVerifierVersion,
  );
  if (!verifyResult.ok) {
    if (verifyResult.reason === "MISSING_PEPPER_VERSION") {
      await logAuditAsync({
        ...tenantAuditBase(request, session.user.id, user.tenantId),
        action: AUDIT_ACTION.VERIFIER_PEPPER_MISSING,
        metadata: { storedVersion: user.passphraseVerifierVersion },
      });
    }
    return errorResponse(API_ERROR.INVALID_PASSPHRASE);
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
        recoveryVerifierVersion: VERIFIER_VERSION,
        recoveryKeySetAt: new Date(),
        // Clear the rotation-invalidated marker; if rotation had previously
        // invalidated the recovery key, this re-generation supersedes it.
        recoveryKeyInvalidatedAt: null,
      },
    }),
  );

  // Audit log: treat post-rotation invalidation as a prior setup so the user
  // sees regenerate-flow wording (not first-time setup) — see plan #433 / F21.
  const isRegeneration = !!user.recoveryKeySetAt || !!user.recoveryKeyInvalidatedAt;
  await logAuditAsync({
    ...personalAuditBase(request, session.user.id),
    action: isRegeneration ? AUDIT_ACTION.RECOVERY_KEY_REGENERATED : AUDIT_ACTION.RECOVERY_KEY_CREATED,
    metadata: { keyVersion: user.keyVersion },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
