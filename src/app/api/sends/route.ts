import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createSendTextSchema } from "@/lib/validations";
import {
  generateShareToken,
  hashToken,
  encryptShareData,
  generateAccessPassword,
  hashAccessPassword,
} from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { rateLimited, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import {
  AUDIT_TARGET_TYPE,
  AUDIT_ACTION,
  AUDIT_SCOPE,
  SEND_EXPIRY_MAP,
} from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";

const sendTextLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// POST /api/sends — Create a text Send
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await sendTextLimiter.check(`rl:send_text:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, createSendTextSchema);
  if (!result.ok) return result.response;

  const { name, text, expiresIn, maxViews, requirePassword } = result.data;

  // Encrypt text content with master key
  const encrypted = encryptShareData(JSON.stringify({ name, text }));

  // Generate access password if requested
  let accessPassword: string | undefined;
  let accessPasswordHash: string | null = null;
  if (requirePassword) {
    accessPassword = generateAccessPassword();
    accessPasswordHash = hashAccessPassword(accessPassword);
  }

  // Generate token
  const token = generateShareToken();
  const tokenHash = hashToken(token);

  const expiresAt = new Date(Date.now() + SEND_EXPIRY_MAP[expiresIn]);
  const actor = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  if (!actor) {
    return unauthorized();
  }

  const share = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.create({
      data: {
        tokenHash,
        shareType: "TEXT",
        entryType: null,
        sendName: name,
        encryptedData: encrypted.ciphertext,
        dataIv: encrypted.iv,
        dataAuthTag: encrypted.authTag,
        masterKeyVersion: encrypted.masterKeyVersion,
        expiresAt,
        maxViews: maxViews ?? null,
        accessPasswordHash,
        createdById: session.user.id,
        tenantId: actor.tenantId,
      },
    }),
  );

  // Audit log
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SEND_CREATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
    targetId: share.id,
    metadata: { sendType: "TEXT", expiresIn, maxViews: maxViews ?? null },
    ip,
    userAgent,
  });

  return NextResponse.json({
    id: share.id,
    token,
    url: `/s/${token}`,
    expiresAt: share.expiresAt,
    ...(accessPassword ? { accessPassword } : {}),
  }, { status: 201 });
}

export const POST = withRequestLog(handlePOST);
