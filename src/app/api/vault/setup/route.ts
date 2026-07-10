import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { withRequestLog } from "@/lib/http/with-request-log";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { getLogger } from "@/lib/logger";
import { z } from "zod";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import {
  hexIv,
  hexAuthTag,
  hexSalt,
  hexHash,
  verificationArtifactSchema,
  WRAPPED_SECRET_KEY_MAX,
  EPHEMERAL_PUBLIC_KEY_MAX,
  ECDH_PRIVATE_KEY_CIPHERTEXT_MAX,
} from "@/lib/validations/common";
import {
  KDF_PBKDF2_ITERATIONS_MIN,
  KDF_PBKDF2_ITERATIONS_MAX,
  KDF_ARGON2_ITERATIONS_MIN,
  KDF_ARGON2_ITERATIONS_MAX,
  KDF_ARGON2_MEMORY_MIN,
  KDF_ARGON2_MEMORY_MAX,
  KDF_ARGON2_PARALLELISM_MIN,
  KDF_ARGON2_PARALLELISM_MAX,
} from "@/lib/validations/common.server";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { PBKDF2_ITERATIONS } from "@/lib/crypto/crypto-params";

export const runtime = "nodejs";

const setupLimiter = createRateLimiter({
  windowMs: 5 * MS_PER_MINUTE,
  max: 5,
  failClosedOnRedisError: true,
});

const kdfParamsSchema = z.discriminatedUnion("kdfType", [
  z.object({
    kdfType: z.literal(0),
    kdfIterations: z.number().int().min(KDF_PBKDF2_ITERATIONS_MIN).max(KDF_PBKDF2_ITERATIONS_MAX),
  }),
  z.object({
    kdfType: z.literal(1),
    kdfIterations: z.number().int().min(KDF_ARGON2_ITERATIONS_MIN).max(KDF_ARGON2_ITERATIONS_MAX),
    kdfMemory: z.number().int().min(KDF_ARGON2_MEMORY_MIN).max(KDF_ARGON2_MEMORY_MAX),
    kdfParallelism: z.number().int().min(KDF_ARGON2_PARALLELISM_MIN).max(KDF_ARGON2_PARALLELISM_MAX),
  }),
]).optional();

const setupSchema = z.object({
  encryptedSecretKey: z.string().min(1).max(WRAPPED_SECRET_KEY_MAX),
  secretKeyIv: hexIv,
  secretKeyAuthTag: hexAuthTag,
  accountSalt: hexSalt,
  authHash: hexHash,
  verifierHash: hexHash,
  verificationArtifact: verificationArtifactSchema,
  // ECDH key pair for team E2E encryption
  ecdhPublicKey: z.string().min(1).max(EPHEMERAL_PUBLIC_KEY_MAX),
  encryptedEcdhPrivateKey: z.string().min(1).max(ECDH_PRIVATE_KEY_CIPHERTEXT_MAX),
  ecdhPrivateKeyIv: hexIv,
  ecdhPrivateKeyAuthTag: hexAuthTag,
  // KDF metadata (optional — server applies defaults if omitted)
  kdfParams: kdfParamsSchema,
});

/**
 * POST /api/vault/setup
 * Initial vault setup: store encrypted secret key and auth hash.
 * Called once when the user first sets a passphrase.
 */
async function handlePOST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const blocked = await checkRateLimitOrFail({
    req: request,
    limiter: setupLimiter,
    key: `rl:vault_setup:${session.user.id}`,
    scope: "vault.setup",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  // Prevent re-setup
  const existingUser = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { vaultSetupAt: true, tenantId: true },
    }),
  );
  if (!existingUser) {
    return unauthorized();
  }
  if (existingUser?.vaultSetupAt) {
    return errorResponse(API_ERROR.VAULT_ALREADY_SETUP);
  }

  const result = await parseBody(request, setupSchema);
  if (!result.ok) return result.response;
  const data = result.data;

  // Reject KDF types that no client's derivation path actually uses yet.
  // Every unlock/wrap call site derives the wrapping key via the param-less
  // deriveWrappingKey() -> PBKDF2-600k. Persisting kdfType=1 (Argon2id) while
  // wrapping under PBKDF2 makes the stored KDF metadata disagree with the real
  // KDF, which would lock the user out the moment a client starts honoring the
  // stored kdfType. Until Argon2id is wired end-to-end (setup + all unlock
  // paths pass params to deriveWrappingKeyWithParams), only PBKDF2 is accepted
  // so the stored metadata always matches the wrapping KDF. The Argon2id schema
  // branch above is kept for that future wiring.
  if (data.kdfParams && data.kdfParams.kdfType !== 0) {
    return errorResponse(API_ERROR.VALIDATION_ERROR);
  }

  // Apply KDF defaults if client omits kdfParams. The guard above narrows
  // kdfParams to the PBKDF2 branch, which has no memory/parallelism params.
  const kdfType = data.kdfParams?.kdfType ?? 0;
  const kdfIterations = data.kdfParams?.kdfIterations ?? PBKDF2_ITERATIONS;
  const kdfMemory = null;
  const kdfParallelism = null;

  // Hash authHash with a server-side salt for storage
  // serverHash = SHA-256(authHash + serverSalt)
  const serverSalt = randomBytes(32).toString("hex");
  const serverHash = createHash("sha256")
    .update(data.authHash + serverSalt)
    .digest("hex");

  await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction([
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
          kdfType,
          kdfIterations,
          kdfMemory,
          kdfParallelism,
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
          tenantId: existingUser.tenantId,
          version: 1,
          verificationCiphertext: data.verificationArtifact.ciphertext,
          verificationIv: data.verificationArtifact.iv,
          verificationAuthTag: data.verificationArtifact.authTag,
        },
      }),
    ]),
  );

  await logAuditAsync({
    ...personalAuditBase(request, session.user.id),
    action: AUDIT_ACTION.VAULT_SETUP,
    metadata: { kdfType, kdfIterations, ...(kdfMemory != null ? { kdfMemory, kdfParallelism } : {}) },
  });

  getLogger().info(
    { userId: session.user.id, kdfType, kdfIterations },
    "vault.setup.success",
  );

  return NextResponse.json({ success: true }, { status: 201 });
}

export const POST = withRequestLog(handlePOST);
