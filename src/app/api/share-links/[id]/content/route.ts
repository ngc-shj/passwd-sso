import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { decryptShareData } from "@/lib/crypto/crypto-server";
import { verifyShareAccessToken } from "@/lib/auth/share-access-token";
import { USER_AGENT_MAX_LENGTH } from "@/lib/validations/common.server";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/ip-access";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, unauthorized, notFound } from "@/lib/api-response";
import { withRequestLog } from "@/lib/with-request-log";

const contentLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

type Params = { params: Promise<{ id: string }> };

// GET /api/share-links/[id]/content — Fetch content for a password-protected share
async function handleGET(req: NextRequest, { params }: Params) {
  const { id } = await params;

  const ip = extractClientIp(req) ?? "unknown";
  const rl = await contentLimiter.check(`rl:share_content:${rateLimitKeyFromIp(ip)}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Extract access token from Authorization header
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse(API_ERROR.SHARE_PASSWORD_REQUIRED, 401);
  }
  const accessToken = authHeader.slice(7);
  if (accessToken.length > 512) {
    return unauthorized();
  }

  // Verify the access token
  if (!verifyShareAccessToken(accessToken, id)) {
    return unauthorized();
  }

  // All DB access must bypass RLS (unauthenticated public endpoint)
  return withBypassRls(prisma, async () => {
    const share = await prisma.passwordShare.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        shareType: true,
        entryType: true,
        encryptedData: true,
        dataIv: true,
        dataAuthTag: true,
        sendName: true,
        sendFilename: true,
        sendSizeBytes: true,
        masterKeyVersion: true,
        expiresAt: true,
        maxViews: true,
        viewCount: true,
        revokedAt: true,
        accessPasswordHash: true,
      },
    });

    if (!share) {
      return notFound();
    }

    // Only allow for password-protected shares
    if (!share.accessPasswordHash) {
      return notFound();
    }

    if (share.revokedAt || share.expiresAt < new Date()) {
      return notFound();
    }

    // Atomically check revocation/expiry/maxViews and increment viewCount.
    // The revoked_at/expires_at predicates are re-asserted here (in addition
    // to the JS check above) to close a TOCTOU window: between findUnique
    // and the UPDATE, the share may be revoked or expire, and we must not
    // leak data in that window.
    // For FILE shares, viewCount is incremented by the download route instead,
    // to prevent bypass via direct download (skipping content API).
    let viewCountDelta = 0;
    if (share.shareType !== "FILE") {
      const updated: number = await prisma.$executeRaw`
        UPDATE "password_shares"
        SET "view_count" = "view_count" + 1
        WHERE "id" = ${share.id}
          AND "revoked_at" IS NULL
          AND "expires_at" > NOW()
          AND ("max_views" IS NULL OR "view_count" < "max_views")`;

      if (updated === 0) {
        return errorResponse(API_ERROR.NOT_FOUND, 410);
      }
      viewCountDelta = 1;
    } else {
      // FILE: check revocation/expiry/maxViews atomically without incrementing.
      // viewCount is incremented by the download route. We use a no-op
      // conditional UPDATE (SET view_count = view_count) to re-assert the
      // state under the same row-lock semantics as the non-FILE path.
      const stillValid: number = await prisma.$executeRaw`
        UPDATE "password_shares"
        SET "view_count" = "view_count"
        WHERE "id" = ${share.id}
          AND "revoked_at" IS NULL
          AND "expires_at" > NOW()
          AND ("max_views" IS NULL OR "view_count" < "max_views")`;

      if (stillValid === 0) {
        return errorResponse(API_ERROR.NOT_FOUND, 410);
      }
    }

    // Record access log (must await inside withBypassRls transaction)
    const accessIp = ip === "unknown" ? null : ip;
    const ua = req.headers.get("user-agent");
    await prisma.shareAccessLog
      .create({
        data: {
          shareId: share.id,
          tenantId: share.tenantId,
          ip: accessIp,
          userAgent: ua?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
        },
      })
      .catch(() => {});

    // E2E share: return encrypted data for client-side decryption
    if (share.masterKeyVersion === 0) {
      return NextResponse.json({
        shareType: share.shareType,
        entryType: share.entryType,
        encryptedData: share.encryptedData,
        dataIv: share.dataIv,
        dataAuthTag: share.dataAuthTag,
        expiresAt: share.expiresAt.toISOString(),
        viewCount: share.viewCount + viewCountDelta,
        maxViews: share.maxViews,
      });
    }

    // Server-encrypted share: decrypt with master key
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(
        decryptShareData(
          {
            ciphertext: share.encryptedData,
            iv: share.dataIv,
            authTag: share.dataAuthTag,
          },
          share.masterKeyVersion
        )
      );
    } catch {
      return notFound();
    }

    return NextResponse.json({
      shareType: share.shareType,
      entryType: share.entryType,
      data,
      sendName: share.sendName,
      sendFilename: share.sendFilename,
      sendSizeBytes: share.sendSizeBytes,
      expiresAt: share.expiresAt.toISOString(),
      viewCount: share.viewCount + viewCountDelta,
      maxViews: share.maxViews,
    });
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

export const GET = withRequestLog(handleGET);
