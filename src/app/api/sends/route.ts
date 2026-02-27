import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createSendTextSchema } from "@/lib/validations";
import {
  generateShareToken,
  hashToken,
  encryptShareData,
} from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  AUDIT_TARGET_TYPE,
  AUDIT_ACTION,
  AUDIT_SCOPE,
  SEND_EXPIRY_MAP,
} from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

const sendTextLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// POST /api/sends — Create a text Send
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await sendTextLimiter.check(`rl:send_text:${session.user.id}`))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = createSendTextSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { name, text, expiresIn, maxViews } = parsed.data;

  // Encrypt text content with master key
  const encrypted = encryptShareData(JSON.stringify({ name, text }));

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
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
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
  });
}
