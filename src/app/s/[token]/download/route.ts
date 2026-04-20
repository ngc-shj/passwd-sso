import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { hashToken, decryptShareBinary } from "@/lib/crypto-server";
import { verifyShareAccessToken } from "@/lib/share-access-token";
import { USER_AGENT_MAX_LENGTH } from "@/lib/validations/common.server";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/ip-access";
import { API_ERROR } from "@/lib/api-error-codes";

const downloadLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

type Params = { params: Promise<{ token: string }> };

// GET /s/[token]/download — Stream download for FILE Send
export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params;

  // Rate limit by IP
  const ip = extractClientIp(req) ?? "unknown";
  if (!(await downloadLimiter.check(`rl:send_download:${rateLimitKeyFromIp(ip)}`)).allowed) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  // Validate token format (must be 64 hex chars)
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return new NextResponse(null, { status: 404 });
  }

  const tokenHash = hashToken(token);

  // All DB access must bypass RLS (unauthenticated public endpoint)
  return withBypassRls(prisma, async () => {
    const share = await prisma.passwordShare.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        shareType: true,
        sendFilename: true,
        sendContentType: true,
        encryptedFile: true,
        fileIv: true,
        fileAuthTag: true,
        masterKeyVersion: true,
        expiresAt: true,
        maxViews: true,
        viewCount: true,
        revokedAt: true,
        accessPasswordHash: true,
      },
    });

    if (!share) {
      return new NextResponse(null, { status: 404 });
    }

    if (share.revokedAt || share.expiresAt < new Date()) {
      return new NextResponse(null, { status: 410 });
    }

    if (share.shareType !== "FILE") {
      return new NextResponse(null, { status: 400 });
    }

    // Password-protected share: verify access token and atomically increment viewCount.
    // The content API skips viewCount increment for FILE type, so download owns it.
    if (share.accessPasswordHash) {
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
      if (!verifyShareAccessToken(accessToken, share.id)) {
        return NextResponse.json(
          { error: API_ERROR.UNAUTHORIZED },
          { status: 401 },
        );
      }

      // Atomically increment viewCount for password-protected downloads.
      // The revoked_at/expires_at predicates are re-asserted here (in addition
      // to the JS check above) to close a TOCTOU window: between findUnique
      // and the UPDATE the share may be revoked or expire, and we must not
      // leak the decrypted file in that window.
      const updated: number = await prisma.$executeRaw`
        UPDATE "password_shares"
        SET "view_count" = "view_count" + 1
        WHERE "id" = ${share.id}
          AND "revoked_at" IS NULL
          AND "expires_at" > NOW()
          AND ("max_views" IS NULL OR "view_count" < "max_views")`;

      if (updated === 0) {
        return new NextResponse(null, { status: 410 });
      }
    } else {
      // Non-protected: atomically check and increment viewCount at download time.
      // Same TOCTOU-closing predicates as the password-protected branch.
      const updated: number = await prisma.$executeRaw`
        UPDATE "password_shares"
        SET "view_count" = "view_count" + 1
        WHERE "id" = ${share.id}
          AND "revoked_at" IS NULL
          AND "expires_at" > NOW()
          AND ("max_views" IS NULL OR "view_count" < "max_views")`;

      if (updated === 0) {
        return new NextResponse(null, { status: 410 });
      }
    }

    if (!share.encryptedFile || !share.fileIv || !share.fileAuthTag) {
      return new NextResponse(null, { status: 404 });
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

    // Decrypt file
    const decrypted = decryptShareBinary({
      ciphertext: Buffer.from(share.encryptedFile),
      iv: share.fileIv,
      authTag: share.fileAuthTag,
    }, share.masterKeyVersion);

    // Sanitize filename for Content-Disposition
    const filename = share.sendFilename ?? "download";
    const encodedFilename = encodeURIComponent(filename);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(decrypted));
        controller.close();
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodedFilename}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        "Content-Length": String(decrypted.length),
      },
    });
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}
