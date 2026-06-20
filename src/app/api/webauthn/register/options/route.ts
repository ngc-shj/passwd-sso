import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  generateRegistrationOpts,
  derivePrfSaltV2,
  generateChallengeId,
} from "@/lib/auth/webauthn/webauthn-server";
import { MS_PER_MINUTE, SEC_PER_MINUTE } from "@/lib/constants/time";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

const CHALLENGE_TTL_SECONDS = 5 * SEC_PER_MINUTE;

// POST /api/webauthn/register/options
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:webauthn_reg_opts:${userId}`,
    scope: "webauthn.reg_options",
    userId,
  });
  if (blocked) return blocked;

  const redis = getRedis();
  if (!redis) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  // Fetch existing credentials to exclude re-registration
  const existingCredentials = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    }),
  );

  const userName = session.user.email ?? session.user.name ?? userId;

  const options = await generateRegistrationOpts(
    userId,
    userName,
    existingCredentials.map((c) => ({
      credentialId: c.credentialId,
      transports: c.transports,
    })),
  );

  // A02-8: generate per-credential PRF salt and bind it to the challenge in
  // a SINGLE Redis envelope so a concurrent register-options request from
  // the same user cannot silently brick the first request's credential
  // (the second tab's `set` overwrites BOTH challenge AND salt — first tab's
  // verify will hit a challenge mismatch and fail cleanly).
  const perCredentialSalt = randomBytes(32).toString("hex");
  let prfSalt: string | null = null;
  try {
    prfSalt = derivePrfSaltV2(perCredentialSalt);
  } catch {
    // PRF secret not configured — passkey will be registered without PRF.
    // perCredentialSalt is still generated (cheap) but stored as null in
    // the envelope so register/verify knows not to persist it.
  }

  const envelope = JSON.stringify({
    challenge: options.challenge,
    prfSalt: prfSalt !== null ? perCredentialSalt : null,
  });

  // Per-flow challengeId in the Redis key so concurrent register flows from the
  // same user (multiple tabs/devices) don't overwrite each other's challenge.
  // userId stays in the key so verify can only consume its own user's challenge.
  const challengeId = generateChallengeId();
  await redis.set(
    `webauthn:challenge:register:${userId}:${challengeId}`,
    envelope,
    "EX",
    CHALLENGE_TTL_SECONDS,
  );

  return NextResponse.json({
    options,
    challengeId,
    prfSupported: prfSalt !== null,
    prfSalt,
  });
}

export const POST = withRequestLog(handlePOST);
