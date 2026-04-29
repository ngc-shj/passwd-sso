import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { verifyShareAccessSchema } from "@/lib/validations";
import { hashToken, verifyAccessPassword } from "@/lib/crypto/crypto-server";
import { createShareAccessToken } from "@/lib/auth/tokens/share-access-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, rateLimited, notFound } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";
import { withRequestLog } from "@/lib/http/with-request-log";

const ipLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
const tokenLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// POST /api/share-links/verify-access — Verify access password for a share
async function handlePOST(req: NextRequest) {
  const ip = extractClientIp(req) ?? "unknown";

  const result = await parseBody(req, verifyShareAccessSchema);
  if (!result.ok) return result.response;

  const { token, password } = result.data;
  const tokenHash = hashToken(token);

  // Rate limit by IP+tokenHash and by tokenHash globally
  const ipRl = await ipLimiter.check(`rl:share_verify_ip:${rateLimitKeyFromIp(ip)}:${tokenHash}`);
  if (!ipRl.allowed) {
    return rateLimited(ipRl.retryAfterMs);
  }
  const tokenRl = await tokenLimiter.check(`rl:share_verify_token:${tokenHash}`);
  if (!tokenRl.allowed) {
    return rateLimited(tokenRl.retryAfterMs);
  }

  const share = await withBypassRls(prisma, () =>
    prisma.passwordShare.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        accessPasswordHash: true,
        accessPasswordHashVersion: true,
        expiresAt: true,
        revokedAt: true,
        maxViews: true,
        viewCount: true,
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!share) {
    return notFound();
  }

  if (share.revokedAt || share.expiresAt < new Date()) {
    return notFound();
  }

  if (share.maxViews !== null && share.viewCount >= share.maxViews) {
    return notFound();
  }

  if (!share.accessPasswordHash) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  const verifyResult = verifyAccessPassword(password, share.accessPasswordHash, share.accessPasswordHashVersion);
  if (!verifyResult.ok) {
    if (verifyResult.reason === "MISSING_PEPPER_VERSION") {
      await logAuditAsync({
        ...tenantAuditBase(req, ANONYMOUS_ACTOR_ID, share.tenantId),
        actorType: ACTOR_TYPE.ANONYMOUS,
        action: AUDIT_ACTION.VERIFIER_PEPPER_MISSING,
        targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
        targetId: share.id,
        metadata: { storedVersion: share.accessPasswordHashVersion },
      });
    }

    await logAuditAsync({
      ...tenantAuditBase(req, ANONYMOUS_ACTOR_ID, share.tenantId),
      actorType: ACTOR_TYPE.ANONYMOUS,
      action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
      targetId: share.id,
      metadata: { ip },
    });

    return errorResponse(API_ERROR.SHARE_PASSWORD_INCORRECT, 403);
  }

  await logAuditAsync({
    ...tenantAuditBase(req, ANONYMOUS_ACTOR_ID, share.tenantId),
    actorType: ACTOR_TYPE.ANONYMOUS,
    action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_SUCCESS,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
    targetId: share.id,
    metadata: { ip },
  });

  const accessToken = createShareAccessToken(share.id);

  return NextResponse.json({ accessToken });
}

export const POST = withRequestLog(handlePOST);
