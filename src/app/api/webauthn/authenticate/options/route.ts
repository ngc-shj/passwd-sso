import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, errorResponseWithMessage, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  generateAuthenticationOpts,
  buildPrfExtensions,
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

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:webauthn_auth_opts:${userId}`,
    scope: "webauthn.auth_options",
    userId,
  });
  if (blocked) return blocked;

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

  // A02-8: include prfSalt in SELECT so buildPrfExtensions can pick
  // per-credential v2 salts vs v1 fallback for this post-login unlock path.
  const credentials = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findMany({
      where: targetCredentialId
        ? { userId, credentialId: targetCredentialId }
        : { userId, prfSupported: true },
      select: { credentialId: true, transports: true, prfSalt: true },
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

  // A02-8: build PRF extension input — v1 fallback for legacy creds + v2
  // evalByCredential overrides for credentials registered after A02-8.
  const prfExt = buildPrfExtensions(credentials);
  const prfSalt: string | null = prfExt?.eval?.first ?? null;
  if (prfExt) {
    // PRF is non-standard per lib.dom.d.ts; widening cast through unknown
    // keeps the field typed without an `any` escape hatch.
    options.extensions = {
      ...options.extensions,
      prf: prfExt,
    } as unknown as typeof options.extensions;
  }

  return NextResponse.json({
    options,
    prfSalt,
  });
}

export const POST = withRequestLog(handlePOST);
