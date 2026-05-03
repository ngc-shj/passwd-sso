import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized, notFound } from "@/lib/http/api-response";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  generateAuthenticationOpts,
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
} from "@/lib/auth/webauthn/webauthn-server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const { id } = await params;

  const rl = await rateLimiter.check(`rl:webauthn_prf_rebootstrap_opts:${userId}`);
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

  // Ownership check — the caller must own the credential they want to
  // re-bootstrap. We also restrict allowCredentials to this single ID so the
  // browser presents only the targeted authenticator.
  const credential = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findFirst({
      where: { id, userId },
      select: { credentialId: true, transports: true },
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

  return NextResponse.json({ options });
}

export const POST = withRequestLog(handlePOST);
