import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited } from "@/lib/api-response";
import { assertOrigin } from "@/lib/auth/csrf";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/ip-access";
import { generateDiscoverableAuthOpts, derivePrfSalt } from "@/lib/auth/webauthn-server";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const CHALLENGE_TTL_SECONDS = 300;

// POST /api/auth/passkey/options
// Unauthenticated endpoint — generates discoverable credential options for passkey sign-in.
async function handlePOST(req: NextRequest) {
  // Defense-in-depth: validate Origin header
  const originError = assertOrigin(req);
  if (originError) return originError;

  // Rate limit by IP
  const ip = extractClientIp(req) ?? "unknown";
  const rl = await rateLimiter.check(`rl:webauthn_signin_opts:${rateLimitKeyFromIp(ip)}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: API_ERROR.SERVICE_UNAVAILABLE },
      { status: 503 },
    );
  }

  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) {
    return NextResponse.json(
      { error: API_ERROR.SERVICE_UNAVAILABLE },
      { status: 503 },
    );
  }

  const options = await generateDiscoverableAuthOpts();

  // Generate a random challengeId (not tied to userId since unauthenticated)
  const challengeId = randomBytes(16).toString("hex");

  // Store challenge in Redis with TTL
  await redis.set(
    `webauthn:challenge:signin:${challengeId}`,
    options.challenge,
    "EX",
    CHALLENGE_TTL_SECONDS,
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
