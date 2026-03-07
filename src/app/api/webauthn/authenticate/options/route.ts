import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  generateAuthenticationOpts,
  derivePrfSalt,
} from "@/lib/webauthn-server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const CHALLENGE_TTL_SECONDS = 300;

// POST /api/webauthn/authenticate/options
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  const rl = await rateLimiter.check(`webauthn:auth-opts:${userId}`);
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

  // Fetch user's credentials that support PRF
  const credentials = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findMany({
      where: { userId, prfSupported: true },
      select: { credentialId: true, transports: true },
    }),
  );

  if (credentials.length === 0) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND, details: "No PRF-capable credentials found" },
      { status: 404 },
    );
  }

  const options = await generateAuthenticationOpts(
    credentials.map((c) => ({
      credentialId: c.credentialId,
      transports: c.transports,
    })),
  );

  // Store challenge in Redis
  await redis.set(
    `webauthn:challenge:authenticate:${userId}`,
    options.challenge,
    "EX",
    CHALLENGE_TTL_SECONDS,
  );

  // Derive PRF salt for vault unlock
  let prfSalt: string | null = null;
  try {
    prfSalt = derivePrfSalt();
  } catch {
    // PRF secret not configured — passkey will authenticate without PRF
  }

  return NextResponse.json({
    options,
    prfSalt,
  });
}

export const POST = withRequestLog(handlePOST);
