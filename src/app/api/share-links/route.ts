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
} from "@/lib/crypto/crypto-server";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { assertPolicyAllowsSharing, assertPolicySharePassword, PolicyViolationError } from "@/lib/team/team-policy";
import { logAuditInTx, personalAuditBase, teamAuditBase } from "@/lib/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, handleAuthError, notFound, rateLimited, unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import {
  TEAM_PERMISSION,
  AUDIT_TARGET_TYPE,
  AUDIT_ACTION,
  applySharePermissions,
} from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/constants/time";

const shareLinkLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const EXPIRY_MAP: Record<string, number> = {
  "1h": MS_PER_HOUR,
  "1d": MS_PER_DAY,
  "7d": 7 * MS_PER_DAY,
  "30d": 30 * MS_PER_DAY,
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
      return handleAuthError(e);
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
  let accessPasswordHashVersion: number = VERIFIER_VERSION;
  if (requirePassword) {
    accessPassword = generateAccessPassword();
    const r = hashAccessPassword(accessPassword);
    accessPasswordHash = r.hash;
    accessPasswordHashVersion = r.version;
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
        accessPasswordHashVersion,
      },
    }),
  );

  // Atomic audit: SHARE_CREATE
  await withBypassRls(prisma, async (tx) => {
    await logAuditInTx(tx, tenantId, {
      ...(teamPasswordEntryId && teamId
        ? teamAuditBase(req, session.user.id, teamId)
        : personalAuditBase(req, session.user.id)),
      action: AUDIT_ACTION.SHARE_CREATE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
      targetId: share.id,
      metadata: { expiresIn, maxViews: maxViews ?? null },
    });
  }, BYPASS_PURPOSE.AUDIT_WRITE);

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
