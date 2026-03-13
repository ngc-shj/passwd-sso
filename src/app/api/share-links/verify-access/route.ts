import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { verifyShareAccessSchema } from "@/lib/validations";
import { hashToken, verifyAccessPassword } from "@/lib/crypto-server";
import { createShareAccessToken } from "@/lib/share-access-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp } from "@/lib/ip-access";
import { logAudit } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";

const ipLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
const tokenLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// POST /api/share-links/verify-access — Verify access password for a share
async function handlePOST(req: NextRequest) {
  const ip = extractClientIp(req) ?? "unknown";
  const ua = req.headers.get("user-agent")?.slice(0, 512) ?? null;

  const result = await parseBody(req, verifyShareAccessSchema);
  if (!result.ok) return result.response;

  const { token, password } = result.data;
  const tokenHash = hashToken(token);

  // Rate limit by IP+tokenHash and by tokenHash globally
  if (!(await ipLimiter.check(`rl:share_verify_ip:${ip}:${tokenHash}`)).allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }
  if (!(await tokenLimiter.check(`rl:share_verify_token:${tokenHash}`)).allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
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
  );

  if (!share) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (share.revokedAt || share.expiresAt < new Date()) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (share.maxViews !== null && share.viewCount >= share.maxViews) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (!share.accessPasswordHash) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR },
      { status: 400 },
    );
  }

  if (!verifyAccessPassword(password, share.accessPasswordHash)) {
    // Log failed attempt
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
      userId: "anonymous",
      tenantId: share.tenantId,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
      targetId: share.id,
      metadata: { ip },
      ip: ip === "unknown" ? null : ip,
      userAgent: ua,
    });

    return NextResponse.json(
      { error: API_ERROR.SHARE_PASSWORD_INCORRECT },
      { status: 403 },
    );
  }

  // Log successful verification
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_SUCCESS,
    userId: "anonymous",
    tenantId: share.tenantId,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
    targetId: share.id,
    metadata: { ip },
    ip: ip === "unknown" ? null : ip,
    userAgent: ua,
  });

  const accessToken = createShareAccessToken(share.id);

  return NextResponse.json({ accessToken });
}

export const POST = withRequestLog(handlePOST);
