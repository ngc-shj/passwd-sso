import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken, decryptShareBinary } from "@/lib/crypto-server";
import { verifyShareAccessToken } from "@/lib/share-access-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp } from "@/lib/ip-access";
import { API_ERROR } from "@/lib/api-error-codes";

const downloadLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

type Params = { params: Promise<{ token: string }> };

// GET /s/[token]/download — Stream download for FILE Send
export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params;

  // Rate limit by IP
  const ip = extractClientIp(req) ?? "unknown";
  if (!(await downloadLimiter.check(`rl:send_download:${ip}`)).allowed) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  // Validate token format (must be 64 hex chars)
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return new NextResponse(null, { status: 404 });
  }

  const tokenHash = hashToken(token);

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

  // Check maxViews (for all shares, not just password-protected)
  if (share.maxViews !== null && share.viewCount >= share.maxViews) {
    return new NextResponse(null, { status: 410 });
  }

  // Password-protected share: verify access token
  if (share.accessPasswordHash) {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: API_ERROR.SHARE_PASSWORD_REQUIRED },
        { status: 401 },
      );
    }
    const accessToken = authHeader.slice(7);
    if (!verifyShareAccessToken(accessToken, share.id)) {
      return NextResponse.json(
        { error: API_ERROR.UNAUTHORIZED },
        { status: 401 },
      );
    }
  }

  if (!share.encryptedFile || !share.fileIv || !share.fileAuthTag) {
    return new NextResponse(null, { status: 404 });
  }

  // Record access log (async nonblocking)
  const accessIp = ip === "unknown" ? null : ip;
  const ua = req.headers.get("user-agent");
  prisma.shareAccessLog
    .create({
      data: {
        shareId: share.id,
        tenantId: share.tenantId,
        ip: accessIp,
        userAgent: ua?.slice(0, 512) ?? null,
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
}
