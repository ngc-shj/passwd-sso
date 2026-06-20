import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized, notFound } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { generateAuthenticationOpts, buildPrfExtensions, WEBAUTHN_CHALLENGE_TTL_SECONDS, generateChallengeId } from "@/lib/auth/webauthn/webauthn-server";
import { getRedis } from "@/lib/redis";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

async function handlePOST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:webauthn_reauth_opts:${session.user.id}`,
    scope: "auth.passkey_reauth_options",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  const redis = getRedis();
  if (!redis) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  if (!process.env.WEBAUTHN_RP_ID) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  // A02-8: include prfSalt for per-credential v2 salt routing in reauth.
  const allowCredentials = await withBypassRls(
    prisma,
    (tx) =>
      tx.webAuthnCredential.findMany({
        where: { userId: session.user.id },
        select: { credentialId: true, transports: true, prfSalt: true },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  if (allowCredentials.length === 0) {
    return notFound();
  }

  const options = await generateAuthenticationOpts(
    allowCredentials.map((credential) => ({
      credentialId: credential.credentialId,
      transports: credential.transports ?? [],
    })),
  );

  const challengeId = generateChallengeId();
  await redis.set(
    `webauthn:challenge:reauth:${session.user.id}:${challengeId}`,
    options.challenge,
    "EX",
    WEBAUTHN_CHALLENGE_TTL_SECONDS,
  );

  // A02-8: merge PRF extension input into options.
  const prfExt = buildPrfExtensions(allowCredentials);
  if (prfExt) {
    options.extensions = {
      ...options.extensions,
      prf: prfExt,
    } as unknown as typeof options.extensions;
  }

  return NextResponse.json({
    options,
    challengeId,
  });
}

export const POST = withRequestLog(handlePOST);
