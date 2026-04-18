import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { assertOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier, verifyPassphraseVerifier } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto-client";
import { withRequestLog } from "@/lib/with-request-log";
import { getLogger } from "@/lib/logger";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { errorResponse, rateLimited, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { hexIv, hexAuthTag, hexSalt, hexHash } from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const changePassphraseSchema = z.object({
  currentVerifierHash: hexHash,
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: hexIv,
  secretKeyAuthTag: hexAuthTag,
  accountSalt: hexSalt,
  newVerifierHash: hexHash,
});

const changeLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 3,
});

/**
 * POST /api/vault/change-passphrase
 * Change the vault passphrase by re-wrapping the secret key.
 * secretKey itself does NOT change — only the wrapping key changes.
 * keyVersion is NOT bumped. EA grants are NOT affected.
 *
 * Server does not perform decryption verification — the rewrapped data
 * is stored as-is. Correctness is verified at next unlock.
 */
async function handlePOST(request: NextRequest) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rateKey = `rl:vault_change_pass:${session.user.id}`;
  const rl = await changeLimiter.check(rateKey);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(request, changePassphraseSchema);
  if (!result.ok) return result.response;
  const data = result.data;

  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        vaultSetupAt: true,
        passphraseVerifierHmac: true,
        passphraseVerifierVersion: true,
      },
    }),
  );

  if (!user?.vaultSetupAt) {
    return errorResponse(API_ERROR.VAULT_NOT_SETUP, 404);
  }

  // Verifier must be set (backfilled during unlock)
  if (!user.passphraseVerifierHmac) {
    return errorResponse(API_ERROR.VERIFIER_NOT_SET, 409);
  }

  // Version check — reject if KDF version doesn't match
  if (user.passphraseVerifierVersion !== VERIFIER_VERSION) {
    return errorResponse(API_ERROR.VERIFIER_VERSION_UNSUPPORTED, 409);
  }

  // Verify current passphrase via verifier
  if (
    !verifyPassphraseVerifier(
      data.currentVerifierHash,
      user.passphraseVerifierHmac
    )
  ) {
    return errorResponse(API_ERROR.INVALID_PASSPHRASE, 401);
  }

  // Update: re-wrapped secret key + new verifier (keyVersion unchanged)
  await withUserTenantRls(session.user.id, async () =>
    prisma.user.update({
      where: { id: session.user.id },
      data: {
        accountSalt: data.accountSalt,
        encryptedSecretKey: data.encryptedSecretKey,
        secretKeyIv: data.secretKeyIv,
        secretKeyAuthTag: data.secretKeyAuthTag,
        passphraseVerifierHmac: hmacVerifier(data.newVerifierHash),
      },
    }),
  );

  getLogger().info({ userId: session.user.id }, "vault.changePassphrase.success");

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
