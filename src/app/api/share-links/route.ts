import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createShareLinkSchema } from "@/lib/validations";
import {
  generateShareToken,
  hashToken,
  encryptShareData,
  generateAccessPassword,
  hashAccessPassword,
} from "@/lib/crypto-server";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { assertPolicyAllowsSharing, assertPolicySharePassword, PolicyViolationError } from "@/lib/team-policy";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, unauthorized, notFound } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import {
  TEAM_PERMISSION,
  AUDIT_TARGET_TYPE,
  AUDIT_ACTION,
  AUDIT_SCOPE,
  applySharePermissions,
} from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";

const shareLinkLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const EXPIRY_MAP: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// POST /api/share-links — Create a share link
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await shareLinkLimiter.check(`rl:share_create:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, createShareLinkSchema);
  if (!result.ok) return result.response;

  const { passwordEntryId, teamPasswordEntryId, data, encryptedShareData, expiresIn, maxViews, permissions, requirePassword } =
    result.data;

  let encryptedData: string;
  let dataIv: string;
  let dataAuthTag: string;
  let masterKeyVersion: number;
  let entryType: EntryTypeValue;
  let teamId: string | undefined;
  let tenantId: string;

  if (passwordEntryId) {
    // Personal entry — verify ownership
    const entry = await withUserTenantRls(session.user.id, async () =>
      prisma.passwordEntry.findUnique({
        where: { id: passwordEntryId },
        select: { userId: true, entryType: true, tenantId: true },
      }),
    );
    if (!entry || entry.userId !== session.user.id) {
      return notFound();
    }

    // `data` is required by schema when `passwordEntryId` is set.
    // TOTP is already stripped by Zod shareDataSchema (no totp field defined)
    entryType = entry.entryType;
    tenantId = entry.tenantId;

    // Apply share permissions: filter fields before encryption
    const filteredData = applySharePermissions(
      data as Record<string, unknown>,
      permissions ?? [],
      entryType,
    );
    const plaintext = JSON.stringify(filteredData);

    // Encrypt share data with master key
    const encrypted = encryptShareData(plaintext);
    encryptedData = encrypted.ciphertext;
    dataIv = encrypted.iv;
    dataAuthTag = encrypted.authTag;
    masterKeyVersion = encrypted.masterKeyVersion;
  } else {
    // Team entry — E2E: client sends pre-encrypted share data
    const teamEntry = await withUserTenantRls(session.user.id, async () =>
      prisma.teamPasswordEntry.findUnique({
        where: { id: teamPasswordEntryId! },
        select: { teamId: true, entryType: true, tenantId: true },
      }),
    );
    if (!teamEntry) {
      return notFound();
    }

    try {
      await requireTeamPermission(
          session.user.id,
          teamEntry.teamId,
          TEAM_PERMISSION.PASSWORD_READ
        );
    } catch (e) {
      if (e instanceof TeamAuthError) {
        return errorResponse(e.message, e.status);
      }
      throw e;
    }

    // Enforce team policy: sharing
    try {
      await assertPolicyAllowsSharing(teamEntry.teamId);
    } catch (e) {
      if (e instanceof PolicyViolationError) {
        return errorResponse(API_ERROR.POLICY_SHARING_DISABLED, 403);
      }
      throw e;
    }

    // Enforce team policy: share password requirement
    try {
      await assertPolicySharePassword(teamEntry.teamId, requirePassword);
    } catch (e) {
      if (e instanceof PolicyViolationError) {
        return errorResponse(API_ERROR.POLICY_SHARE_PASSWORD_REQUIRED, 403);
      }
      throw e;
    }

    // Store client-encrypted data as-is (masterKeyVersion=0 = E2E share)
    encryptedData = encryptedShareData!.ciphertext;
    dataIv = encryptedShareData!.iv;
    dataAuthTag = encryptedShareData!.authTag;
    masterKeyVersion = 0;
    entryType = teamEntry.entryType as EntryTypeValue;
    teamId = teamEntry.teamId;
    tenantId = teamEntry.tenantId;
  }

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

  const expiresAt = new Date(Date.now() + EXPIRY_MAP[expiresIn]);

  const share = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.create({
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
        tenantId,
        passwordEntryId: passwordEntryId ?? null,
        teamPasswordEntryId: teamPasswordEntryId ?? null,
        permissions: permissions ?? [],
        accessPasswordHash,
      },
    }),
  );

  // Audit log
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: teamPasswordEntryId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SHARE_CREATE,
    userId: session.user.id,
    teamId,
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
    ...(accessPassword ? { accessPassword } : {}),
  }, { status: 201 });
}

// GET /api/share-links — List share links for an entry
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { searchParams } = new URL(req.url);
  const passwordEntryId = searchParams.get("passwordEntryId");
  const teamPasswordEntryId = searchParams.get("teamPasswordEntryId");

  if (!passwordEntryId && !teamPasswordEntryId) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  const where: Record<string, unknown> = {
    createdById: session.user.id,
  };
  if (passwordEntryId) where.passwordEntryId = passwordEntryId;
  if (teamPasswordEntryId) where.teamPasswordEntryId = teamPasswordEntryId;

  const shares = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.findMany({
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
    }),
  );

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

export const POST = withRequestLog(handlePOST);
export const GET = withRequestLog(handleGET);
