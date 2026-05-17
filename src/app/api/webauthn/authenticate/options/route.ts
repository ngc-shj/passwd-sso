import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, errorResponseWithMessage, rateLimited, serviceUnavailable, unauthorized } from "@/lib/http/api-response";
import { emitRateLimitFailClosed } from "@/lib/security/rate-limit-audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  generateAuthenticationOpts,
  derivePrfSalt,
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
} from "@/lib/auth/webauthn/webauthn-server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

// POST /api/webauthn/authenticate/options
// Body: { credentialId?: string }
// When credentialId is provided, generates options for that specific credential
// (regardless of PRF support). Otherwise, only PRF-capable credentials are used.
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const rl = await rateLimiter.check(`rl:webauthn_auth_opts:${userId}`);
  if (rl.redisErrored) {
    void emitRateLimitFailClosed({
      req,
      scope: "webauthn.auth_options",
      userId,
      tenantId: null,
    });
    return serviceUnavailable();
  }
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const redis = getRedis();
  if (!redis) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  // Parse optional body for targeted credential test
  // req.json bypass: optional-body semantics preserved; falls back to PRF-only mode on parse error.
  let targetCredentialId: string | undefined;
  try {
    const body = await req.json();
    if (body?.credentialId && typeof body.credentialId === "string" && body.credentialId.length <= 256) {
      targetCredentialId = body.credentialId;
    }
  } catch {
    // No body or invalid JSON — use default PRF-only behavior
  }

  // Fetch credentials: specific credential or PRF-capable only
  const credentials = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findMany({
      where: targetCredentialId
        ? { userId, credentialId: targetCredentialId }
        : { userId, prfSupported: true },
      select: { credentialId: true, transports: true },
    }),
  );

  if (credentials.length === 0) {
    return errorResponseWithMessage(API_ERROR.NOT_FOUND, "No matching credentials found");
  }

  const options = await generateAuthenticationOpts(
    credentials.map((c) => ({
      credentialId: c.credentialId,
      transports: c.transports,
    })),
  );

  // Store challenge in Redis
  await redis.set(
    `webauthn:challenge:authenticate:${userId}`,
    options.challenge,
    "EX",
    WEBAUTHN_CHALLENGE_TTL_SECONDS,
  );

  // Derive PRF salt for vault unlock
  let prfSalt: string | null = null;
  try {
    prfSalt = derivePrfSalt();
  } catch {
    // PRF secret not configured — passkey will authenticate without PRF
  }

  return NextResponse.json({
    options,
    prfSalt,
  });
}

export const POST = withRequestLog(handlePOST);
