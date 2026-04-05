import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, unauthorized } from "@/lib/api-response";
import { validateExtensionToken } from "@/lib/extension-token";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  EXTENSION_TOKEN_DEFAULT_SCOPES,
  EXTENSION_TOKEN_TTL_MS,
  EXTENSION_TOKEN_MAX_ACTIVE,
} from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";
import { TokenIssueResponseSchema, TokenRevokeResponseSchema } from "@/lib/validations/extension-token";
import logger from "@/lib/logger";

function internalError() {
  return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
}

export const runtime = "nodejs";

const tokenLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

/**
 * POST /api/extension/token — Issue a new extension token.
 * Requires Auth.js session (user must be logged in on the web app).
 * Returns the plaintext token (only visible once).
 */
async function handlePOST() {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await tokenLimiter.check(`rl:ext_token:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXTENSION_TOKEN_TTL_MS);
  const plaintext = generateShareToken();
  const tokenHash = hashToken(plaintext);
  const scopeCsv = EXTENSION_TOKEN_DEFAULT_SCOPES.join(",");
  const actor = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  if (!actor) {
    return unauthorized();
  }

  const created = await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction(async (tx) => {
      // Find active tokens (non-revoked, non-expired)
      const active = await tx.extensionToken.findMany({
        where: { userId: session.user.id, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      // Revoke oldest if at max (need room for the new one)
      const over = active.length + 1 - EXTENSION_TOKEN_MAX_ACTIVE;
      if (over > 0) {
        const toRevoke = active.slice(0, over).map((t) => t.id);
        await tx.extensionToken.updateMany({
          where: { id: { in: toRevoke } },
          data: { revokedAt: now },
        });
      }

      return tx.extensionToken.create({
        data: { userId: session.user.id, tenantId: actor.tenantId, tokenHash, scope: scopeCsv, expiresAt },
        select: { id: true, expiresAt: true, scope: true },
      });
    }),
  );

  const body = {
    token: plaintext,
    expiresAt: created.expiresAt.toISOString(),
    scope: created.scope.split(","),
  };

  const parsed = TokenIssueResponseSchema.safeParse(body);
  if (!parsed.success) {
    logger.error({ error: parsed.error.message }, "extension token issue response validation failed");
    return internalError();
  }

  return NextResponse.json(parsed.data, { status: 201 });
}

/**
 * DELETE /api/extension/token — Revoke the token used in Authorization header.
 * The Bearer token identifies which token to revoke.
 */
async function handleDELETE(req: NextRequest) {
  const result = await validateExtensionToken(req);

  if (!result.ok) {
    const statusMap: Record<string, number> = {
      EXTENSION_TOKEN_INVALID: 404,
      EXTENSION_TOKEN_REVOKED: 400,
      EXTENSION_TOKEN_EXPIRED: 400,
    };
    return errorResponse(API_ERROR[result.error], statusMap[result.error] ?? 400);
  }

  await withUserTenantRls(result.data.userId, async () =>
    prisma.extensionToken.update({
      where: { id: result.data.tokenId },
      data: { revokedAt: new Date() },
    }),
  );

  const body = { ok: true as const };

  const parsed = TokenRevokeResponseSchema.safeParse(body);
  if (!parsed.success) {
    logger.error({ error: parsed.error.message }, "extension token revoke response validation failed");
    return internalError();
  }

  return NextResponse.json(parsed.data);
}

export const POST = withRequestLog(handlePOST);
export const DELETE = withRequestLog(handleDELETE);
