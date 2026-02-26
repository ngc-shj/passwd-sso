import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createShareLinkSchema } from "@/lib/validations";
import {
  generateShareToken,
  hashToken,
  encryptShareData,
} from "@/lib/crypto-server";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
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

  const { passwordEntryId, orgPasswordEntryId, data, encryptedShareData, expiresIn, maxViews } =
    parsed.data;

  let encryptedData: string;
  let dataIv: string;
  let dataAuthTag: string;
  let masterKeyVersion: number;
  let entryType: EntryTypeValue;
  let orgId: string | undefined;

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
    // TOTP is already stripped by Zod shareDataSchema (no totp field defined)
    entryType = entry.entryType;
    const plaintext = JSON.stringify(data);

    // Encrypt share data with master key
    const encrypted = encryptShareData(plaintext);
    encryptedData = encrypted.ciphertext;
    dataIv = encrypted.iv;
    dataAuthTag = encrypted.authTag;
    masterKeyVersion = encrypted.masterKeyVersion;
  } else {
    // Team entry — E2E: client sends pre-encrypted share data
    const orgEntry = await prisma.orgPasswordEntry.findUnique({
      where: { id: orgPasswordEntryId! },
      select: { orgId: true, entryType: true },
    });
    if (!orgEntry) {
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
    }

    try {
      await requireTeamPermission(
        session.user.id,
        orgEntry.orgId,
        TEAM_PERMISSION.PASSWORD_READ
      );
    } catch (e) {
      if (e instanceof TeamAuthError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }

    // Store client-encrypted data as-is (masterKeyVersion=0 = E2E share)
    encryptedData = encryptedShareData!.ciphertext;
    dataIv = encryptedShareData!.iv;
    dataAuthTag = encryptedShareData!.authTag;
    masterKeyVersion = 0;
    entryType = orgEntry.entryType as EntryTypeValue;
    orgId = orgEntry.orgId;
  }

  // Generate token
  const token = generateShareToken();
  const tokenHash = hashToken(token);

  const expiresAt = new Date(Date.now() + EXPIRY_MAP[expiresIn]);

  const share = await prisma.passwordShare.create({
    data: {
      tokenHash,
      entryType,
      encryptedData,
      dataIv,
      dataAuthTag,
      masterKeyVersion,
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
    scope: orgPasswordEntryId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SHARE_CREATE,
    userId: session.user.id,
    orgId,
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
