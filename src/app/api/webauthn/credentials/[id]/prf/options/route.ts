import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, unauthorized, notFound } from "@/lib/http/api-response";
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

/**
 * POST /api/webauthn/credentials/[id]/prf/options
 *
 * Issue a one-shot WebAuthn challenge for the PRF re-bootstrap flow. The
 * challenge is stored in Redis under a DEDICATED namespace
 * (`webauthn:challenge:prf-rebootstrap:${userId}`) — separate from the sign-in
 * `webauthn:challenge:authenticate:${userId}` key — so that:
 *
 *   1. A concurrent sign-in `getdel` cannot consume the rebootstrap challenge.
 *   2. An attacker who can hit one endpoint cannot DoS the other's pending
 *      challenge by spamming options requests.
 *   3. A captured assertion meant for sign-in cannot be replayed against the
 *      rebootstrap endpoint within the challenge TTL window (#433 / S-N1).
 *
 * The TTL constant `WEBAUTHN_CHALLENGE_TTL_SECONDS` is shared with the sign-in
 * options endpoint so both flows tune in lockstep.
 */
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const { id } = await params;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:webauthn_prf_rebootstrap_opts:${userId}`,
    scope: "webauthn.prf_options",
    userId,
  });
  if (blocked) return blocked;

  const redis = getRedis();
  if (!redis) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  // Ownership check — the caller must own the credential they want to
  // re-bootstrap. We also restrict allowCredentials to this single ID so the
  // browser presents only the targeted authenticator.
  // A02-8: include prfSalt so PRF rebootstrap reuses the credential's
  // existing salt (immutable per C1) — re-wrap binds to the SAME salt so
  // future unlocks continue to work.
  const credential = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findFirst({
      where: { id, userId },
      select: { credentialId: true, transports: true, prfSalt: true },
    }),
  );

  if (!credential) {
    return notFound();
  }

  const options = await generateAuthenticationOpts([
    {
      credentialId: credential.credentialId,
      transports: credential.transports,
    },
  ]);

  await redis.set(
    `webauthn:challenge:prf-rebootstrap:${userId}`,
    options.challenge,
    "EX",
    WEBAUTHN_CHALLENGE_TTL_SECONDS,
  );

  // A02-8: embed PRF extension input. For v2 credentials (prfSalt != null),
  // buildPrfExtensions emits evalByCredential keyed by the cred id. For
  // legacy v1 credentials, it emits only the top-level eval.first.
  const prfExt = buildPrfExtensions([
    { credentialId: credential.credentialId, prfSalt: credential.prfSalt },
  ]);
  if (prfExt) {
    options.extensions = {
      ...options.extensions,
      prf: prfExt,
    } as unknown as typeof options.extensions;
  }

  return NextResponse.json({ options });
}

export const POST = withRequestLog(handlePOST);
