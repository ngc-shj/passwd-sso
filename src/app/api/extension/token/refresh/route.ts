import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { validateExtensionToken, revokeExtensionTokenFamily, EXTENSION_TOKEN_REVOKE_REASON } from "@/lib/auth/tokens/extension-token";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { TokenIssueResponseSchema } from "@/lib/validations/extension-token";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import logger from "@/lib/logger";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT,
  EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_DEFAULT,
} from "@/lib/validations/common";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
  recordPasskeyAuditEmit,
} from "@/lib/auth/policy/passkey-enforcement";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";

export const runtime = "nodejs";

const refreshLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 20,
  failClosedOnRedisError: true,
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

  const { tokenId, userId, tenantId, scopes, familyId, familyCreatedAt, cnfJkt } = result.data;

  // Tenant network-boundary enforcement comes BEFORE rate limit so an
  // off-network holder of a stolen bearer cannot burn the legitimate
  // user's per-user refresh budget (DoS the live extension). tenantId
  // comes directly from the validated token row.
  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: refreshLimiter,
    key: `rl:ext_refresh:${userId}`,
    scope: "extension.token_refresh",
    userId,
    tenantId,
  });
  if (blocked) return blocked;

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
  const tenant = await withBypassRls(prisma, async (tx) =>
    tx.tenant.findUnique({
      where: { id: activeSession.tenantId },
      select: {
        extensionTokenIdleTimeoutMinutes: true,
        extensionTokenAbsoluteTimeoutMinutes: true,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  const idleMinutes = tenant?.extensionTokenIdleTimeoutMinutes ?? EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT;
  const absoluteMinutes = tenant?.extensionTokenAbsoluteTimeoutMinutes ?? EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_DEFAULT;

  const now = new Date();

  // Family absolute timeout enforcement. Pre-migration tokens have null familyId;
  // we refuse to refresh them so every live token eventually converges to a family.
  if (!familyId || !familyCreatedAt) {
    return errorResponse(API_ERROR.EXTENSION_TOKEN_SESSION_EXPIRED);
  }
  const familyAgeMs = now.getTime() - familyCreatedAt.getTime();
  if (familyAgeMs > absoluteMinutes * MS_PER_MINUTE) {
    // Revoke the entire family and audit. Do NOT issue a new token.
    await revokeExtensionTokenFamily({
      familyId,
      userId,
      tenantId: activeSession.tenantId,
      reason: EXTENSION_TOKEN_REVOKE_REASON.FAMILY_EXPIRED,
    });
    return errorResponse(API_ERROR.EXTENSION_TOKEN_SESSION_EXPIRED);
  }

  // C8: Passkey enforcement gate — re-derive fresh from DB, fail closed.
  // Tenant source = the tenant the refreshed token will be bound to (activeSession.tenantId).
  const passkeyState = await derivePasskeyState({ userId, tenantId: activeSession.tenantId });
  if (passkeyEnforcementBlocks(passkeyState)) {
    if (recordPasskeyAuditEmit(userId, "/api/extension/token/refresh", Date.now())) {
      await logAuditAsync({
        ...personalAuditBase(req, userId),
        tenantId: activeSession.tenantId,
        action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
        metadata: { blockedPath: "/api/extension/token/refresh" },
      });
    }
    return errorResponse(API_ERROR.PASSKEY_REQUIRED);
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
          // Carry cnfJkt forward — DPoP binding MUST persist across rotation
          cnfJkt,
        },
        select: { expiresAt: true, scope: true, cnfJkt: true },
      });

      return newToken;
    }),
  );

  if (!created) {
    return errorResponse(API_ERROR.EXTENSION_TOKEN_REVOKED);
  }

  const body = {
    token: plaintext,
    expiresAt: created.expiresAt.toISOString(),
    scope: created.scope.split(","),
    cnfJkt: created.cnfJkt,
  };

  const parsed = TokenIssueResponseSchema.safeParse(body);
  if (!parsed.success) {
    logger.error({ error: parsed.error.message }, "extension token refresh response validation failed");
    return errorResponse(API_ERROR.INTERNAL_ERROR);
  }

  return NextResponse.json(parsed.data, { headers: { ...NO_STORE_HEADERS } });
}

export const POST = withRequestLog(handlePOST);
