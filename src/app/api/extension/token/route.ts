import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { TokenRevokeResponseSchema } from "@/lib/validations/extension-token";
import logger from "@/lib/logger";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";

function internalError() {
  return errorResponse(API_ERROR.INTERNAL_ERROR);
}

export const runtime = "nodejs";

const legacyDeprecatedLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

/**
 * POST /api/extension/token — DEPRECATED. Always returns 410 Gone.
 * The bridge-code exchange flow (POST /api/extension/token/exchange) is
 * the only supported path to obtain an extension token.
 */
async function handlePOST(req: NextRequest) {
  // 1. IP-keyed rate limit — cap audit writes and warn logs per source IP.
  const ip = extractClientIp(req);
  const rl = await checkIpRateLimit({
    ip,
    pathname: req.nextUrl.pathname,
    scope: "ext_token_legacy_blocked",
    limiter: legacyDeprecatedLimiter,
  });
  const blocked = await checkRateLimitOrFail({
    req,
    result: rl,
    scope: "extension.token_legacy_blocked",
    userId: null,
  });
  if (blocked) return blocked;

  // 2. Anonymous audit emission — fire-and-forget; goes to dead-letter
  // because no tenantId is resolvable (handler intentionally skips auth()).
  await logAuditAsync({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED,
    userId: ANONYMOUS_ACTOR_ID,
    actorType: ACTOR_TYPE.ANONYMOUS,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  // 3. Structured warn — primary observability surface (dead-letter for audit row).
  logger.warn(
    { event: "extension_token_legacy_issuance_blocked", ip },
    "legacy extension token issuance attempted — endpoint is gone",
  );

  // 4. 410 Gone with Deprecation header per RFC 9745.
  //    Cache-Control: no-store prevents intermediary caches from memoizing
  //    the 410 across deploys; this endpoint is never cacheable.
  return errorResponse(
    API_ERROR.EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED,
    undefined,
    undefined,
    { Deprecation: "true", "Cache-Control": "no-store" },
  );
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
