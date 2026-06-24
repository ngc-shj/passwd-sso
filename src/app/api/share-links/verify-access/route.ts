import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { verifyShareAccessSchema } from "@/lib/validations";
import { hashToken, verifyAccessPassword } from "@/lib/crypto/crypto-server";
import { createShareAccessToken } from "@/lib/auth/tokens/share-access-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, notFound } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const ipLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 5,
  failClosedOnRedisError: true,
});
const tokenLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 20,
  failClosedOnRedisError: true,
});

// POST /api/share-links/verify-access — Verify access password for a share
async function handlePOST(req: NextRequest) {
  const ip = extractClientIp(req);

  const result = await parseBody(req, verifyShareAccessSchema);
  if (!result.ok) return result.response;

  const { token, password } = result.data;
  const tokenHash = hashToken(token);

  // Rate limit by IP+tokenHash and by tokenHash globally
  const ipRl = await checkIpRateLimit({
    ip,
    pathname: req.nextUrl.pathname,
    scope: "share_verify_ip",
    keySuffix: tokenHash,
    limiter: ipLimiter,
  });
  const ipBlocked = await checkRateLimitOrFail({
    req,
    result: ipRl,
    scope: "share.verify_access_ip",
    userId: null,
  });
  if (ipBlocked) return ipBlocked;
  const tokenBlocked = await checkRateLimitOrFail({
    req,
    limiter: tokenLimiter,
    key: `rl:share_verify_token:${tokenHash}`,
    scope: "share.verify_access_token",
    userId: null,
  });
  if (tokenBlocked) return tokenBlocked;

  const share = await withBypassRls(prisma, (tx) =>
    tx.passwordShare.findUnique({
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
    // Collapse to 404 rather than a distinct validation error: a share that
    // exists but is not password-protected must not be distinguishable here
    // from a non-existent one (anti-enumeration). The normal client flow for
    // an unprotected share never calls verify-access — it goes straight to the
    // content endpoint.
    return notFound();
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

    return errorResponse(API_ERROR.SHARE_PASSWORD_INCORRECT);
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

  return NextResponse.json({ accessToken }, { headers: { ...NO_STORE_HEADERS } });
}

export const POST = withRequestLog(handlePOST);
