import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { decryptShareData } from "@/lib/crypto-server";
import { verifyShareAccessToken } from "@/lib/share-access-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp } from "@/lib/ip-access";
import { API_ERROR } from "@/lib/api-error-codes";

const contentLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

type Params = { params: Promise<{ id: string }> };

// GET /api/share-links/[id]/content — Fetch content for a password-protected share
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;

  const ip = extractClientIp(req) ?? "unknown";
  if (!(await contentLimiter.check(`rl:share_content:${ip}`)).allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  // Extract access token from Authorization header
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: API_ERROR.SHARE_PASSWORD_REQUIRED },
      { status: 401 },
    );
  }
  const accessToken = authHeader.slice(7);
  if (accessToken.length > 512) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  // Verify the access token
  if (!verifyShareAccessToken(accessToken, id)) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
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
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
    }

    // Only allow for password-protected shares
    if (!share.accessPasswordHash) {
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
    }

    if (share.revokedAt || share.expiresAt < new Date()) {
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
    }

    // Atomically check maxViews and increment viewCount.
    // For FILE shares, viewCount is incremented by the download route instead,
    // to prevent bypass via direct download (skipping content API).
    let viewCountDelta = 0;
    if (share.shareType !== "FILE") {
      const updated: number = await prisma.$executeRaw`
        UPDATE "password_shares"
        SET "view_count" = "view_count" + 1
        WHERE "id" = ${share.id}
          AND ("max_views" IS NULL OR "view_count" < "max_views")`;

      if (updated === 0) {
        return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 410 });
      }
      viewCountDelta = 1;
    } else {
      // FILE: just check maxViews without incrementing
      if (share.maxViews !== null && share.viewCount >= share.maxViews) {
        return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 410 });
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
          userAgent: ua?.slice(0, 512) ?? null,
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
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
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
  });
}
