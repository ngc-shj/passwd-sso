import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto-client";
import { withRequestLog } from "@/lib/with-request-log";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { getLogger } from "@/lib/logger";
import { z } from "zod";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import {
  hexIv,
  hexAuthTag,
  hexSalt,
  hexHash,
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

export const runtime = "nodejs";

const setupLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 5 });

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
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: hexIv,
  secretKeyAuthTag: hexAuthTag,
  accountSalt: hexSalt,
  authHash: hexHash,
  verifierHash: hexHash,
  verificationArtifact: z.object({
    ciphertext: z.string().min(1),
    iv: hexIv,
    authTag: hexAuthTag,
  }),
  // ECDH key pair for team E2E encryption
  ecdhPublicKey: z.string().min(1),
  encryptedEcdhPrivateKey: z.string().min(1),
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

  if (!(await setupLimiter.check(`rl:vault_setup:${session.user.id}`)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

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
    return errorResponse(API_ERROR.VAULT_ALREADY_SETUP, 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }

  const parsed = setupSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error.flatten());
  }

  const data = parsed.data;

  // Apply KDF defaults if client omits kdfParams
  const kdfType = data.kdfParams?.kdfType ?? 0;
  const kdfIterations = data.kdfParams?.kdfIterations ?? 600_000;
  const kdfMemory = data.kdfParams && "kdfMemory" in data.kdfParams ? data.kdfParams.kdfMemory : null;
  const kdfParallelism = data.kdfParams && "kdfParallelism" in data.kdfParams ? data.kdfParams.kdfParallelism : null;

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

  const { ip, userAgent } = extractRequestMeta(request);
  logAudit({
    scope: "PERSONAL",
    action: "VAULT_SETUP",
    userId: session.user.id,
    metadata: { kdfType, kdfIterations, ...(kdfMemory != null ? { kdfMemory, kdfParallelism } : {}) },
    ip,
    userAgent,
  });

  getLogger().info(
    { userId: session.user.id, kdfType, kdfIterations },
    "vault.setup.success",
  );

  return NextResponse.json({ success: true }, { status: 201 });
}

export const POST = withRequestLog(handlePOST);
