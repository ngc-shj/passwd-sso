import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { assertOrigin } from "@/lib/csrf";
import { generateDiscoverableAuthOpts } from "@/lib/webauthn-server";
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
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await rateLimiter.check(`webauthn:signin-opts:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
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
    { EX: CHALLENGE_TTL_SECONDS },
  );

  return NextResponse.json({
    options,
    challengeId,
  });
}

export const POST = withRequestLog(handlePOST);
