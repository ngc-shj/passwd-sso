import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { verifyShareAccessSchema } from "@/lib/validations";
import { hashToken, verifyAccessPassword } from "@/lib/crypto-server";
import { createShareAccessToken } from "@/lib/share-access-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/ip-access";
import { logAuditInTx, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, notFound } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";

const ipLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
const tokenLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// POST /api/share-links/verify-access — Verify access password for a share
async function handlePOST(req: NextRequest) {
  const ip = extractClientIp(req) ?? "unknown";
  const reqMeta = extractRequestMeta(req);

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

  if (!verifyAccessPassword(password, share.accessPasswordHash)) {
    // Atomic audit: SHARE_ACCESS_VERIFY_FAILED
    await withBypassRls(prisma, async (tx) => {
      await logAuditInTx(tx, share.tenantId, {
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
        userId: "anonymous",
        tenantId: share.tenantId,
        targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
        targetId: share.id,
        metadata: { ip },
        ...reqMeta,
      });
    }, BYPASS_PURPOSE.AUDIT_WRITE);

    return errorResponse(API_ERROR.SHARE_PASSWORD_INCORRECT, 403);
  }

  // Atomic audit: SHARE_ACCESS_VERIFY_SUCCESS
  await withBypassRls(prisma, async (tx) => {
    await logAuditInTx(tx, share.tenantId, {
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_SUCCESS,
      userId: "anonymous",
      tenantId: share.tenantId,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
      targetId: share.id,
      metadata: { ip },
      ...reqMeta,
    });
  }, BYPASS_PURPOSE.AUDIT_WRITE);

  const accessToken = createShareAccessToken(share.id);

  return NextResponse.json({ accessToken });
}

export const POST = withRequestLog(handlePOST);
