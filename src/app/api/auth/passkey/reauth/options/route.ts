import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, rateLimited, unauthorized, notFound } from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { generateAuthenticationOpts, WEBAUTHN_CHALLENGE_TTL_SECONDS } from "@/lib/auth/webauthn/webauthn-server";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

async function handlePOST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await rateLimiter.check(`rl:webauthn_reauth_opts:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const redis = getRedis();
  if (!redis) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  if (!process.env.WEBAUTHN_RP_ID) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  const allowCredentials = await withBypassRls(
    prisma,
    () =>
      prisma.webAuthnCredential.findMany({
        where: { userId: session.user.id },
        select: { credentialId: true, transports: true },
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

  const challengeId = randomBytes(16).toString("hex");
  await redis.set(
    `webauthn:challenge:reauth:${session.user.id}:${challengeId}`,
    options.challenge,
    "EX",
    WEBAUTHN_CHALLENGE_TTL_SECONDS,
  );

  return NextResponse.json({
    options,
    challengeId,
  });
}

export const POST = withRequestLog(handlePOST);
