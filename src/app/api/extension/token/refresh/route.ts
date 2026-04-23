import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, unauthorized } from "@/lib/api-response";
import { validateExtensionToken, revokeExtensionTokenFamily } from "@/lib/auth/extension-token";
import { enforceAccessRestriction } from "@/lib/auth/access-restriction";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { TokenIssueResponseSchema } from "@/lib/validations/extension-token";
import logger from "@/lib/logger";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const refreshLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
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

  const { tokenId, userId, tenantId, scopes, familyId, familyCreatedAt } = result.data;

  // Tenant network-boundary enforcement comes BEFORE rate limit so an
  // off-network holder of a stolen bearer cannot burn the legitimate
  // user's per-user refresh budget (DoS the live extension). tenantId
  // comes directly from the validated token row.
  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const rl = await refreshLimiter.check(`rl:ext_refresh:${userId}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
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

  // Read tenant extension-token TTL policy
  const tenant = await withBypassRls(prisma, async () =>
    prisma.tenant.findUnique({
      where: { id: activeSession.tenantId },
      select: {
        extensionTokenIdleTimeoutMinutes: true,
        extensionTokenAbsoluteTimeoutMinutes: true,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  const idleMinutes = tenant?.extensionTokenIdleTimeoutMinutes ?? 10080;
  const absoluteMinutes = tenant?.extensionTokenAbsoluteTimeoutMinutes ?? 43200;

  const now = new Date();

  // Family absolute timeout enforcement. Pre-migration tokens have null familyId;
  // we refuse to refresh them so every live token eventually converges to a family.
  if (!familyId || !familyCreatedAt) {
    return errorResponse(API_ERROR.EXTENSION_TOKEN_FAMILY_EXPIRED, 401);
  }
  const familyAgeMs = now.getTime() - familyCreatedAt.getTime();
  if (familyAgeMs > absoluteMinutes * MS_PER_MINUTE) {
    // Revoke the entire family and audit. Do NOT issue a new token.
    await revokeExtensionTokenFamily({
      familyId,
      userId,
      tenantId: activeSession.tenantId,
      reason: "family_expired",
    });
    return errorResponse(API_ERROR.EXTENSION_TOKEN_FAMILY_EXPIRED, 401);
  }

  // Interactive transaction: revoke old (optimistic lock), then create new only if revoke succeeded
  const expiresAt = new Date(now.getTime() + idleMinutes * MS_PER_MINUTE);
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
          // Carry the family forward so the absolute cap persists across rotations
          familyId,
          familyCreatedAt,
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
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }

  return NextResponse.json(parsed.data);
}

export const POST = withRequestLog(handlePOST);
