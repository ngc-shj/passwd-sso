import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRedis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { assertOrigin } from "@/lib/csrf";
import { NIL_UUID } from "@/lib/constants/app";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/ip-access";
import { generateAuthenticationOpts, derivePrfSalt } from "@/lib/webauthn-server";
import { randomBytes } from "node:crypto";
import { EMAIL_MAX_LENGTH } from "@/lib/validations/common";
import { PASSKEY_DUMMY_CREDENTIALS_MAX } from "@/lib/validations/common.server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

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

  const ip = extractClientIp(req) ?? "unknown";
  const rl = await rateLimiter.check(`rl:webauthn_email_signin_opts:${rateLimitKeyFromIp(ip)}`);
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

  const result = await parseBody(req, emailSchema);
  if (!result.ok) return result.response;
  const { email } = result.data;

  // Look up user and their credentials (cross-tenant, unauthenticated)
  let allowCredentials: Array<{ credentialId: string; transports: string[] }>;

  const user = await withBypassRls(prisma, async () =>
    prisma.user.findFirst({
      where: { email },
      select: {
        id: true,
        tenant: { select: { isBootstrap: true } },
      },
    }),
  BYPASS_PURPOSE.AUTH_FLOW);

  // SSO tenant users are rejected by the verify route's tenant guard,
  // so treat them the same as "not found" to avoid leaking info.
  if (user && (user.tenant === null || user.tenant.isBootstrap)) {
    const credentials = await withBypassRls(prisma, async () =>
      prisma.webAuthnCredential.findMany({
        where: { userId: user.id },
        select: { credentialId: true, transports: true },
      }),
    BYPASS_PURPOSE.AUTH_FLOW);
    allowCredentials =
      credentials.length > 0 ? credentials : generateDummyCredentials();
  } else {
    // Timing mitigation: run a dummy DB query so the response time is
    // indistinguishable from the real-user path (prevents user enumeration
    // via timing oracle).
    await withBypassRls(prisma, async () =>
      prisma.webAuthnCredential.findMany({
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

  let prfSalt: string | null = null;
  try {
    prfSalt = derivePrfSalt();
  } catch {
    // PRF secret not configured
  }

  return NextResponse.json({
    options,
    challengeId,
    prfSalt,
  });
}

export const POST = withRequestLog(handlePOST);
