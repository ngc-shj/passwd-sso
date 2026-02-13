import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { validateExtensionToken } from "@/lib/extension-token";
import { EXTENSION_TOKEN_TTL_MS } from "@/lib/constants";

export const runtime = "nodejs";

const refreshLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
});

/**
 * POST /api/extension/token/refresh
 *
 * Accepts a still-valid Bearer token and issues a new token with fresh TTL.
 * The old token is revoked atomically.
 */
export async function POST(req: NextRequest) {
  const result = await validateExtensionToken(req);

  if (!result.ok) {
    return NextResponse.json(
      { error: API_ERROR[result.error] },
      { status: 401 },
    );
  }

  const { tokenId, userId, scopes } = result.data;

  if (!(await refreshLimiter.check(`rl:ext_refresh:${userId}`))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  // Verify user's Auth.js session is still active
  const activeSession = await prisma.session.findFirst({
    where: {
      userId,
      expires: { gt: new Date() },
    },
    select: { id: true },
  });

  if (!activeSession) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  // Atomic: revoke old, create new
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXTENSION_TOKEN_TTL_MS);
  const plaintext = generateShareToken();
  const newTokenHash = hashToken(plaintext);
  const scopeCsv = scopes.join(",");

  await prisma.$transaction([
    prisma.extensionToken.update({
      where: { id: tokenId },
      data: { revokedAt: now },
    }),
    prisma.extensionToken.create({
      data: {
        userId,
        tokenHash: newTokenHash,
        scope: scopeCsv,
        expiresAt,
      },
    }),
  ]);

  return NextResponse.json({
    token: plaintext,
    expiresAt: expiresAt.toISOString(),
    scope: scopes,
  });
}
