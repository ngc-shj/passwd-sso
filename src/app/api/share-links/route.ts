import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createShareLinkSchema } from "@/lib/validations";
import {
  generateShareToken,
  hashToken,
  encryptShareData,
  unwrapOrgKey,
  decryptServerData,
} from "@/lib/crypto-server";
import { buildOrgEntryAAD } from "@/lib/crypto-aad";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  ORG_PERMISSION,
  AUDIT_TARGET_TYPE,
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

const shareLinkLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const EXPIRY_MAP: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// POST /api/share-links — Create a share link
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await shareLinkLimiter.check(`rl:share_create:${session.user.id}`))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = createShareLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { passwordEntryId, orgPasswordEntryId, data, expiresIn, maxViews } =
    parsed.data;

  let plaintext: string;
  let entryType: EntryTypeValue;

  if (passwordEntryId) {
    // Personal entry — verify ownership
    const entry = await prisma.passwordEntry.findUnique({
      where: { id: passwordEntryId },
      select: { userId: true, entryType: true },
    });
    if (!entry || entry.userId !== session.user.id) {
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
    }
    // `data` is required by schema when `passwordEntryId` is set.
    // Keep defensive fallback to empty object to avoid runtime throws on malformed inputs.
    const { ...safeData } = data;
    entryType = entry.entryType;
    plaintext = JSON.stringify(safeData);
  } else {
    // Org entry — verify permission
    const entry = await prisma.orgPasswordEntry.findUnique({
      where: { id: orgPasswordEntryId! },
      include: {
        org: {
          select: {
            id: true,
            encryptedOrgKey: true,
            orgKeyIv: true,
            orgKeyAuthTag: true,
            masterKeyVersion: true,
          },
        },
      },
    });
    if (!entry) {
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
    }

    try {
      await requireOrgPermission(
        session.user.id,
        entry.org.id,
        ORG_PERMISSION.PASSWORD_READ
      );
    } catch (e) {
      if (e instanceof OrgAuthError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }

    // Decrypt org entry → strip TOTP → re-encrypt with master key
    const orgKey = unwrapOrgKey({
      ciphertext: entry.org.encryptedOrgKey,
      iv: entry.org.orgKeyIv,
      authTag: entry.org.orgKeyAuthTag,
    }, entry.org.masterKeyVersion);
    const blobAad = entry.aadVersion >= 1
      ? Buffer.from(buildOrgEntryAAD(entry.org.id, entry.id, "blob"))
      : undefined;
    const blob = JSON.parse(
      decryptServerData(
        { ciphertext: entry.encryptedBlob, iv: entry.blobIv, authTag: entry.blobAuthTag },
        orgKey,
        blobAad
      )
    );

    // Strip TOTP
    delete blob.totp;

    entryType = entry.entryType;
    plaintext = JSON.stringify(blob);
  }

  // Encrypt share data with master key
  const encrypted = encryptShareData(plaintext);

  // Generate token
  const token = generateShareToken();
  const tokenHash = hashToken(token);

  const expiresAt = new Date(Date.now() + EXPIRY_MAP[expiresIn]);

  const share = await prisma.passwordShare.create({
    data: {
      tokenHash,
      entryType,
      encryptedData: encrypted.ciphertext,
      dataIv: encrypted.iv,
      dataAuthTag: encrypted.authTag,
      masterKeyVersion: encrypted.masterKeyVersion,
      expiresAt,
      maxViews: maxViews ?? null,
      createdById: session.user.id,
      passwordEntryId: passwordEntryId ?? null,
      orgPasswordEntryId: orgPasswordEntryId ?? null,
    },
  });

  // Audit log
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: orgPasswordEntryId ? AUDIT_SCOPE.ORG : AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SHARE_CREATE,
    userId: session.user.id,
    orgId: orgPasswordEntryId
      ? (
          await prisma.orgPasswordEntry.findUnique({
            where: { id: orgPasswordEntryId },
            select: { orgId: true },
          })
        )?.orgId
      : undefined,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
    targetId: share.id,
    metadata: { expiresIn, maxViews: maxViews ?? null },
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

// GET /api/share-links — List share links for an entry
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const passwordEntryId = searchParams.get("passwordEntryId");
  const orgPasswordEntryId = searchParams.get("orgPasswordEntryId");

  if (!passwordEntryId && !orgPasswordEntryId) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR },
      { status: 400 }
    );
  }

  const where: Record<string, unknown> = {
    createdById: session.user.id,
  };
  if (passwordEntryId) where.passwordEntryId = passwordEntryId;
  if (orgPasswordEntryId) where.orgPasswordEntryId = orgPasswordEntryId;

  const shares = await prisma.passwordShare.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      expiresAt: true,
      maxViews: true,
      viewCount: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  const now = new Date();
  return NextResponse.json({
    items: shares.map((s) => ({
      ...s,
      isActive:
        !s.revokedAt &&
        s.expiresAt > now &&
        (s.maxViews === null || s.viewCount < s.maxViews),
    })),
  });
}
