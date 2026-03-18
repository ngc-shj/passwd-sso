import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/api-response";
import { validateExtensionToken } from "@/lib/extension-token";
import { EXTENSION_TOKEN_TTL_MS } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { TokenIssueResponseSchema } from "@/lib/validations/extension-token";
import logger from "@/lib/logger";

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
async function handlePOST(req: NextRequest) {
  const result = await validateExtensionToken(req);

  if (!result.ok) {
    return errorResponse(API_ERROR[result.error], 401);
  }

  const { tokenId, userId, scopes } = result.data;

  if (!(await refreshLimiter.check(`rl:ext_refresh:${userId}`)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  // Verify user's Auth.js session is still active
  const activeSession = await withUserTenantRls(userId, async () =>
    prisma.session.findFirst({
      where: {
        userId,
        expires: { gt: new Date() },
      },
      select: { id: true, tenantId: true },
    }),
  );

  if (!activeSession) {
    return unauthorized();
  }

  // Interactive transaction: revoke old (optimistic lock), then create new only if revoke succeeded
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXTENSION_TOKEN_TTL_MS);
  const plaintext = generateShareToken();
  const newTokenHash = hashToken(plaintext);
  const scopeCsv = scopes.join(",");

  const created = await withUserTenantRls(userId, async () =>
    prisma.$transaction(async (tx) => {
      const revoked = await tx.extensionToken.updateMany({
        where: { id: tokenId, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });

      if (revoked.count === 0) {
        return null; // Already revoked by concurrent refresh
      }

      const newToken = await tx.extensionToken.create({
        data: {
          userId,
          tenantId: activeSession.tenantId,
          tokenHash: newTokenHash,
          scope: scopeCsv,
          expiresAt,
        },
        select: { expiresAt: true, scope: true },
      });

      return newToken;
    }),
  );

  if (!created) {
    return errorResponse(API_ERROR.EXTENSION_TOKEN_REVOKED, 401);
  }

  const body = {
    token: plaintext,
    expiresAt: created.expiresAt.toISOString(),
    scope: created.scope.split(","),
  };

  const parsed = TokenIssueResponseSchema.safeParse(body);
  if (!parsed.success) {
    logger.error({ error: parsed.error.message }, "extension token refresh response validation failed");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  return NextResponse.json(parsed.data);
}

export const POST = withRequestLog(handlePOST);
