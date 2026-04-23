import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, unauthorized } from "@/lib/api-response";
import { issueExtensionToken, validateExtensionToken } from "@/lib/auth/extension-token";
import { enforceAccessRestriction } from "@/lib/auth/access-restriction";
import { withUserTenantRls } from "@/lib/tenant-context";
import { EXTENSION_TOKEN_DEFAULT_SCOPES } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";
import { TokenIssueResponseSchema, TokenRevokeResponseSchema } from "@/lib/validations/extension-token";
import logger from "@/lib/logger";
import { MS_PER_MINUTE } from "@/lib/constants/time";

function internalError() {
  return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
}

export const runtime = "nodejs";

const tokenLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
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

  // Migration metric (Step 11): emit a counter so we can track when the legacy
  // direct-issuance endpoint stops being called and the bridge code flow has
  // fully replaced it.
  logger.info(
    {
      event: "extension_token_legacy_issuance",
      userId: session.user.id,
    },
    "legacy direct extension token issuance — track for migration completion",
  );

  const issued = await withUserTenantRls(session.user.id, async (tenantId) =>
    issueExtensionToken({
      userId: session.user.id,
      tenantId,
      scope: EXTENSION_TOKEN_DEFAULT_SCOPES.join(","),
    }),
  );

  const body = {
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    scope: issued.scopeCsv.split(","),
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

  // Tenant network-boundary enforcement: Bearer bypasses middleware access
  // restriction, so the full extension-token lifecycle (issue/refresh/revoke)
  // must be gated at the tenant CIDR / Tailscale boundary. tenantId is
  // taken directly from the validated token row (not resolved from userId)
  // to avoid a silent fail-open if user→tenant resolution returns null.
  const denied = await enforceAccessRestriction(
    req,
    result.data.userId,
    result.data.tenantId,
  );
  if (denied) return denied;

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
