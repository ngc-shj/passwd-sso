import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { checkStoredVerifier } from "@/lib/vault/stored-verifier-server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import { logAuditInTx, personalAuditBase } from "@/lib/audit/audit";
import { withTenantRls } from "@/lib/tenant-rls";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { hexIv, hexAuthTag, hexSalt, hexHash, WRAPPED_SECRET_KEY_MAX } from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const generateSchema = z.object({
  currentVerifierHash: hexHash,
  encryptedSecretKey: z.string().min(1).max(WRAPPED_SECRET_KEY_MAX),
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
        accountSalt: true,
        tenantId: true,
      },
    }),
  );

  if (!user?.vaultSetupAt) {
    return errorResponse(API_ERROR.VAULT_NOT_SETUP);
  }

  // Verify current passphrase via verifier
  const verifier = await checkStoredVerifier(request, {
    userId: session.user.id,
    tenantId: user.tenantId,
    clientVerifierHash: data.currentVerifierHash,
    storedHmac: user.passphraseVerifierHmac,
    storedVersion: user.passphraseVerifierVersion,
  });
  if (verifier !== "ok") {
    return errorResponse(
      verifier === "not-set" ? API_ERROR.VERIFIER_NOT_SET : API_ERROR.INVALID_PASSPHRASE,
    );
  }

  // Store the recovery wrap, as a compare-and-swap on the vault wrap the
  // verifier was checked against. The check above read a snapshot in another
  // transaction; a rotate-key that commits in between clears the recovery wrap
  // and moves keyVersion (and accountSalt), and an unconditional write would
  // then store a recovery wrap of the retired secret key and clear
  // recoveryKeyInvalidatedAt, so a later recover would restore the old key.
  // accountSalt is the column every vault-wrapping writer moves; keyVersion is
  // the one rotation moves. A lost race writes nothing and no audit row (409).
  //
  // The audit row commits with the wrap (logAuditInTx). Post-rotation
  // invalidation counts as a prior setup so the user sees regenerate-flow
  // wording (not first-time setup) — see plan #433 / F21. One call per action
  // keeps each action literal, which check-critical-audit-atomic reads.
  const isRegeneration = !!user.recoveryKeySetAt || !!user.recoveryKeyInvalidatedAt;
  const committed = await withTenantRls(prisma, user.tenantId, async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: session.user.id, accountSalt: user.accountSalt, keyVersion: user.keyVersion },
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
    });
    if (count === 0) return false;

    const base = personalAuditBase(request, session.user.id);
    const metadata = { keyVersion: user.keyVersion };
    if (isRegeneration) {
      await logAuditInTx(tx, user.tenantId, {
        ...base,
        action: AUDIT_ACTION.RECOVERY_KEY_REGENERATED,
        metadata,
      });
    } else {
      await logAuditInTx(tx, user.tenantId, {
        ...base,
        action: AUDIT_ACTION.RECOVERY_KEY_CREATED,
        metadata,
      });
    }
    return true;
  });

  if (!committed) {
    return errorResponse(API_ERROR.VAULT_WRAP_CONFLICT);
  }

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
