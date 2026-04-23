import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited } from "@/lib/api-response";
import { withUserTenantRls } from "@/lib/tenant-context";
import { generateRegistrationOpts, derivePrfSalt } from "@/lib/auth/webauthn-server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const CHALLENGE_TTL_SECONDS = 300;

// POST /api/webauthn/register/options
async function handlePOST(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  const rl = await rateLimiter.check(`rl:webauthn_reg_opts:${userId}`);
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

  // Store challenge in Redis (consume-once, TTL 300s)
  await redis.set(
    `webauthn:challenge:register:${userId}`,
    options.challenge,
    "EX",
    CHALLENGE_TTL_SECONDS,
  );

  // Derive PRF salt so the client can use it during credential creation
  let prfSalt: string | null = null;
  try {
    prfSalt = derivePrfSalt();
  } catch {
    // PRF secret not configured — passkey will be registered without PRF
  }

  return NextResponse.json({
    options,
    prfSupported: prfSalt !== null,
    prfSalt,
  });
}

export const POST = withRequestLog(handlePOST);
