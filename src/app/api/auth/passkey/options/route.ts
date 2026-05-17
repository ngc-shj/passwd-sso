import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, rateLimited, serviceUnavailable } from "@/lib/http/api-response";
import { emitRateLimitFailClosed } from "@/lib/security/rate-limit-audit";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import {
  generateDiscoverableAuthOpts,
  derivePrfSalt,
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
} from "@/lib/auth/webauthn/webauthn-server";
import { randomBytes } from "node:crypto";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

// POST /api/auth/passkey/options
// Unauthenticated endpoint — generates discoverable credential options for passkey sign-in.
async function handlePOST(req: NextRequest) {
  // Defense-in-depth: validate Origin header
  const originError = assertOrigin(req);
  if (originError) return originError;

  // Rate limit by IP
  const rl = await checkIpRateLimit({
    ip: extractClientIp(req),
    pathname: req.nextUrl.pathname,
    scope: "webauthn_signin_opts",
    limiter: rateLimiter,
  });
  if (rl.redisErrored) {
    void emitRateLimitFailClosed({
      req,
      scope: "auth.passkey_options",
      userId: null,
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

  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  const options = await generateDiscoverableAuthOpts();

  // Generate a random challengeId (not tied to userId since unauthenticated)
  const challengeId = randomBytes(16).toString("hex");

  // Store challenge in Redis with TTL
  await redis.set(
    `webauthn:challenge:signin:${challengeId}`,
    options.challenge,
    "EX",
    WEBAUTHN_CHALLENGE_TTL_SECONDS,
  );

  // Derive PRF salt so the client can request PRF in the same ceremony
  let prfSalt: string | null = null;
  try {
    prfSalt = derivePrfSalt();
  } catch {
    // PRF secret not configured — sign-in will work without PRF
  }

  return NextResponse.json({
    options,
    challengeId,
    prfSalt,
  });
}

export const POST = withRequestLog(handlePOST);
