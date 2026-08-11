import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { generateAuthenticationOpts, buildPrfExtensions, WEBAUTHN_CHALLENGE_TTL_SECONDS, generateChallengeId } from "@/lib/auth/webauthn/webauthn-server";
import { getRedis } from "@/lib/redis";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { getSessionTokenDigest } from "@/app/api/sessions/helpers";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";

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

  const sessionTokenDigest = getSessionTokenDigest(req);
  if (!sessionTokenDigest) {
    return unauthorized();
  }

  // C3: the ceremony must offer exactly the credential that established this
  // session — never every credential of the user (finding E1). Both the
  // session row and the bound credential are read under one bypass call; the
  // credential lookup's `where` is a literal object built only once
  // `authCredentialId` has been narrowed to non-null, never
  // `id: authCredentialId ?? undefined` (Prisma reads `undefined` as "no
  // filter" and would silently widen back to any credential of the user).
  const gate = await withBypassRls(
    prisma,
    async (tx) => {
      const row = await tx.session.findUnique({
        where: { sessionToken: sessionTokenDigest },
        select: { provider: true, authCredentialId: true },
      });
      if (!row || row.provider !== "webauthn" || row.authCredentialId === null) {
        return { row, credential: null };
      }
      // A02-8: include prfSalt for per-credential v2 salt routing in reauth.
      const credential = await tx.webAuthnCredential.findFirst({
        where: { id: row.authCredentialId, userId: session.user.id },
        select: { credentialId: true, transports: true, prfSalt: true },
      });
      return { row, credential };
    },
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  if (!gate.row) {
    return unauthorized();
  }

  if (gate.row.provider !== "webauthn") {
    await logAuditAsync({
      ...personalAuditBase(req, session.user.id),
      action: AUDIT_ACTION.AUTH_PASSKEY_REAUTH_UNAVAILABLE,
      metadata: { reason: "provider" },
    });
    return errorResponse(API_ERROR.SESSION_STEP_UP_REQUIRED);
  }

  if (gate.row.authCredentialId === null) {
    await logAuditAsync({
      ...personalAuditBase(req, session.user.id),
      action: AUDIT_ACTION.AUTH_PASSKEY_REAUTH_UNAVAILABLE,
      metadata: { reason: "no_binding" },
    });
    return errorResponse(API_ERROR.PASSKEY_REAUTH_UNAVAILABLE);
  }

  // Reachable, not defensive dead code: the session read and this lookup are
  // two statements with no lock between them, so a credential deleted in
  // between lands here (finding N9 — the FK does not make this unreachable).
  if (!gate.credential) {
    await logAuditAsync({
      ...personalAuditBase(req, session.user.id),
      action: AUDIT_ACTION.AUTH_PASSKEY_REAUTH_UNAVAILABLE,
      metadata: { reason: "credential_missing" },
    });
    return errorResponse(API_ERROR.PASSKEY_REAUTH_UNAVAILABLE);
  }

  const allowCredentials = [gate.credential];

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
