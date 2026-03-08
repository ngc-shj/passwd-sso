import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRedis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { assertOrigin } from "@/lib/csrf";
import { generateAuthenticationOpts, derivePrfSalt } from "@/lib/webauthn-server";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const CHALLENGE_TTL_SECONDS = 300;

const emailSchema = z.object({
  email: z.string().email().max(254),
});

/**
 * Generate dummy allowCredentials for user enumeration mitigation.
 * Returns 1-3 random credential IDs so the response shape is
 * indistinguishable from a real user's credentials.
 */
function generateDummyCredentials(): Array<{
  credentialId: string;
  transports: string[];
}> {
  // Avoid modulo bias: map [0,255] to [1,3] uniformly
  const count = 1 + Math.floor((randomBytes(1)[0] / 256) * 3);
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

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await rateLimiter.check(`webauthn:email-signin-opts:${ip}`);
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_JSON },
      { status: 400 },
    );
  }

  const parsed = emailSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR },
      { status: 400 },
    );
  }

  const { email } = parsed.data;

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
  );

  // SSO tenant users are rejected by the verify route's tenant guard,
  // so treat them the same as "not found" to avoid leaking info.
  if (user && (user.tenant === null || user.tenant.isBootstrap)) {
    const credentials = await withBypassRls(prisma, async () =>
      prisma.webAuthnCredential.findMany({
        where: { userId: user.id },
        select: { credentialId: true, transports: true },
      }),
    );
    allowCredentials =
      credentials.length > 0 ? credentials : generateDummyCredentials();
  } else {
    // Timing mitigation: run a dummy DB query so the response time is
    // indistinguishable from the real-user path (prevents user enumeration
    // via timing oracle).
    await withBypassRls(prisma, async () =>
      prisma.webAuthnCredential.findMany({
        where: { userId: "00000000-0000-0000-0000-000000000000" },
        select: { credentialId: true, transports: true },
        take: 3,
      }),
    );
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
