import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRedis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { NIL_UUID } from "@/lib/constants/app";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { generateAuthenticationOpts, buildPrfExtensions } from "@/lib/auth/webauthn/webauthn-server";
import { randomBytes } from "node:crypto";
import { EMAIL_MAX_LENGTH } from "@/lib/validations/common";
import { PASSKEY_DUMMY_CREDENTIALS_MAX } from "@/lib/validations/common.server";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

const CHALLENGE_TTL_SECONDS = 300;

const emailSchema = z.object({
  email: z.string().email().max(EMAIL_MAX_LENGTH),
});

/**
 * Generate dummy allowCredentials for user enumeration mitigation.
 * Returns 1-3 random credential IDs so the response shape is
 * indistinguishable from a real user's credentials.
 */
function uniformRandom(max: number): number {
  // Rejection sampling: discard values >= largest multiple of max to avoid bias
  const limit = 256 - (256 % max);
  let value: number;
  do {
    value = randomBytes(1)[0];
  } while (value >= limit);
  return value % max;
}

function generateDummyCredentials(): Array<{
  credentialId: string;
  transports: string[];
}> {
  const count = 1 + uniformRandom(PASSKEY_DUMMY_CREDENTIALS_MAX);
  return Array.from({ length: count }, () => ({
    credentialId: randomBytes(32).toString("base64url"),
    transports: ["usb"] as string[],
  }));
}

// POST /api/auth/passkey/options/email
// Unauthenticated — generates authentication options with allowCredentials
// for a specific email's registered credentials (non-discoverable support).
async function handlePOST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const rl = await checkIpRateLimit({
    ip: extractClientIp(req),
    pathname: req.nextUrl.pathname,
    scope: "webauthn_email_signin_opts",
    limiter: rateLimiter,
  });
  const blocked = await checkRateLimitOrFail({
    req,
    result: rl,
    scope: "auth.passkey_options_email",
    userId: null,
  });
  if (blocked) return blocked;

  const redis = getRedis();
  if (!redis) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  const result = await parseBody(req, emailSchema);
  if (!result.ok) return result.response;
  const { email } = result.data;

  // Look up user and their credentials (cross-tenant, unauthenticated)
  let allowCredentials: Array<{ credentialId: string; transports: string[] }>;

  const user = await withBypassRls(prisma, async (tx) =>
    tx.user.findFirst({
      where: { email },
      select: {
        id: true,
        tenant: { select: { isBootstrap: true } },
      },
    }),
  BYPASS_PURPOSE.AUTH_FLOW);

  // SSO tenant users are rejected by the verify route's tenant guard,
  // so treat them the same as "not found" to avoid leaking info.
  // A02-8: include prfSalt in the SELECT so buildPrfExtensions can route
  // per-credential v2 salts and v1 fallback. Single source of truth for the
  // credential list so allowCredentials and PRF extension stay in lockstep.
  let credentialsForPrf: Array<{ credentialId: string; prfSalt: string | null }> = [];

  if (user && (user.tenant === null || user.tenant.isBootstrap)) {
    const credentials = await withBypassRls(prisma, async (tx) =>
      tx.webAuthnCredential.findMany({
        where: { userId: user.id },
        select: { credentialId: true, transports: true, prfSalt: true },
      }),
    BYPASS_PURPOSE.AUTH_FLOW);
    if (credentials.length > 0) {
      allowCredentials = credentials.map((c) => ({
        credentialId: c.credentialId,
        transports: c.transports,
      }));
      credentialsForPrf = credentials.map((c) => ({
        credentialId: c.credentialId,
        prfSalt: c.prfSalt,
      }));
    } else {
      allowCredentials = generateDummyCredentials();
    }
  } else {
    // Timing mitigation: run a dummy DB query so the response time is
    // indistinguishable from the real-user path (prevents user enumeration
    // via timing oracle).
    await withBypassRls(prisma, async (tx) =>
      tx.webAuthnCredential.findMany({
        where: { userId: NIL_UUID },
        select: { credentialId: true, transports: true },
        take: PASSKEY_DUMMY_CREDENTIALS_MAX,
      }),
    BYPASS_PURPOSE.AUTH_FLOW);
    allowCredentials = generateDummyCredentials();
  }

  const options = await generateAuthenticationOpts(allowCredentials);

  const challengeId = randomBytes(16).toString("hex");

  // Same Redis key pattern as discoverable flow — verify route is shared
  await redis.set(
    `webauthn:challenge:signin:${challengeId}`,
    options.challenge,
    "EX",
    CHALLENGE_TTL_SECONDS,
  );

  // A02-8 F3: when the credentials list is empty (user not found or has no
  // credentials), we still need a v1-shaped PRF extension response so the
  // shape matches the real-user path and the timing-equalization branch
  // doesn't accidentally introduce a user-enumeration oracle. Inject a
  // single fake v1-style entry (`prfSalt: null`) so buildPrfExtensions
  // emits `{ eval: { first: v1 RP-global } }` exactly like a real all-v1
  // user. evalByCredential is omitted; v2 logic stays purely
  // credential-driven for real users.
  const prfExtInput =
    credentialsForPrf.length > 0
      ? credentialsForPrf
      : [{ credentialId: "_timing-equalization-dummy_", prfSalt: null as string | null }];
  const builtExt = buildPrfExtensions(prfExtInput);
  // When the input list contains only dummy entries, strip evalByCredential
  // (it would leak the dummy credentialId on the wire).
  const prfExt = builtExt && credentialsForPrf.length === 0
    ? (builtExt.eval ? { eval: builtExt.eval } : null)
    : builtExt;
  const prfSalt: string | null = prfExt?.eval?.first ?? null;
  if (prfExt) {
    options.extensions = {
      ...options.extensions,
      prf: prfExt,
    } as unknown as typeof options.extensions;
  }

  return NextResponse.json({
    options,
    challengeId,
    prfSalt,
  });
}

export const POST = withRequestLog(handlePOST);
