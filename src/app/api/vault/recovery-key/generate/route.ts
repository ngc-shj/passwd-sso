import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { hmacVerifier, verifyPassphraseVerifier } from "@/lib/crypto-server";
import { API_ERROR } from "@/lib/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto-client";
import { assertOrigin } from "@/lib/csrf";
import { withRequestLog } from "@/lib/with-request-log";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";

export const runtime = "nodejs";

const generateSchema = z.object({
  currentVerifierHash: z.string().regex(/^[0-9a-f]{64}$/),
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: z.string().regex(/^[0-9a-f]{24}$/),
  secretKeyAuthTag: z.string().regex(/^[0-9a-f]{32}$/),
  hkdfSalt: z.string().regex(/^[0-9a-f]{64}$/),
  verifierHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const generateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
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
  if (!(await generateLimiter.check(rateKey))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_JSON },
      { status: 400 },
    );
  }

  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data = parsed.data;

  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        vaultSetupAt: true,
        passphraseVerifierHmac: true,
        passphraseVerifierVersion: true,
        recoveryKeySetAt: true,
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
  const { ip, userAgent } = extractRequestMeta(request);
  logAudit({
    scope: "PERSONAL",
    action: isRegeneration ? "RECOVERY_KEY_REGENERATED" : "RECOVERY_KEY_CREATED",
    userId: session.user.id,
    ip,
    userAgent,
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
