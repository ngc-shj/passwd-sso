import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier, verifyPassphraseVerifier } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto-client";
import { withRequestLog } from "@/lib/with-request-log";
import { getLogger } from "@/lib/logger";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";

export const runtime = "nodejs";

const changePassphraseSchema = z.object({
  currentVerifierHash: z.string().regex(/^[0-9a-f]{64}$/),
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: z.string().regex(/^[0-9a-f]{24}$/), // 12 bytes hex
  secretKeyAuthTag: z.string().regex(/^[0-9a-f]{32}$/), // 16 bytes hex
  accountSalt: z.string().regex(/^[0-9a-f]{64}$/), // 32 bytes hex
  newVerifierHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const changeLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
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
async function handlePOST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rateKey = `rl:vault_change_pass:${session.user.id}`;
  if (!(await changeLimiter.check(rateKey)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }

  const parsed = changePassphraseSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error.flatten());
  }

  const data = parsed.data;

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
