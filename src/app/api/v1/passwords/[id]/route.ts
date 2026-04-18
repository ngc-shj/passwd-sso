import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit";
import { updateE2EPasswordSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { validateV1Auth } from "@/lib/v1-auth";
import { withRequestLog } from "@/lib/with-request-log";
import { withTenantRls } from "@/lib/tenant-rls";
import { v1ApiKeyLimiter } from "@/lib/rate-limiters";
import { API_KEY_SCOPE } from "@/lib/constants/api-key";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { enforceAccessRestriction } from "@/lib/access-restriction";


import { notFound, rateLimited, validationError } from "@/lib/api-response";
import type { V1AuthResult } from "@/lib/v1-auth";

type V1AuthData = Extract<V1AuthResult, { ok: true }>["data"];

type AuthCheckResult =
  | { ok: false; error: NextResponse }
  | { ok: true; data: V1AuthData };

async function checkAuth(
  req: NextRequest,
  scope: (typeof API_KEY_SCOPE)[keyof typeof API_KEY_SCOPE],
): Promise<AuthCheckResult> {
  const authResult = await validateV1Auth(req, scope);
  if (!authResult.ok) {
    const status = authResult.error === "SCOPE_INSUFFICIENT" ? 403 : 401;
    const error = status === 403 ? API_ERROR.API_KEY_SCOPE_INSUFFICIENT : API_ERROR.UNAUTHORIZED;
    return { ok: false, error: NextResponse.json({ error }, { status }) };
  }

  const rl = await v1ApiKeyLimiter.check(`rl:api_key:${authResult.data.rateLimitKey}`);
  if (!rl.allowed) {
    return { ok: false, error: rateLimited(rl.retryAfterMs) };
  }

  return { ok: true, data: authResult.data };
}

// GET /api/v1/passwords/[id]
async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkAuth(req, API_KEY_SCOPE.PASSWORDS_READ);
  if (!auth.ok) return auth.error;
  const { userId, tenantId } = auth.data;

  if (!userId) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED, message: "Service account tokens cannot access personal data via v1 API. Use MCP Gateway." },
      { status: 403 },
    );
  }

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const { id } = await params;

  const entry = await withTenantRls(prisma, tenantId, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      include: { tags: { select: { id: true } } },
    }),
  );

  if (!entry || entry.userId !== userId) {
    return notFound();
  }

  return NextResponse.json({
    id: entry.id,
    encryptedBlob: {
      ciphertext: entry.encryptedBlob,
      iv: entry.blobIv,
      authTag: entry.blobAuthTag,
    },
    encryptedOverview: {
      ciphertext: entry.encryptedOverview,
      iv: entry.overviewIv,
      authTag: entry.overviewAuthTag,
    },
    keyVersion: entry.keyVersion,
    aadVersion: entry.aadVersion,
    entryType: entry.entryType,
    isFavorite: entry.isFavorite,
    isArchived: entry.isArchived,
    requireReprompt: entry.requireReprompt,
    expiresAt: entry.expiresAt,
    folderId: entry.folderId,
    tagIds: entry.tags.map((t) => t.id),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

// PUT /api/v1/passwords/[id]
async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkAuth(req, API_KEY_SCOPE.PASSWORDS_WRITE);
  if (!auth.ok) return auth.error;
  const { userId, tenantId } = auth.data;

  if (!userId) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED, message: "Service account tokens cannot access personal data via v1 API. Use MCP Gateway." },
      { status: 403 },
    );
  }

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const { id } = await params;

  const existing = await withTenantRls(prisma, tenantId, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: {
        userId: true,
        tenantId: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        keyVersion: true,
        aadVersion: true,
      },
    }),
  );

  if (!existing || existing.userId !== userId) {
    return notFound();
  }

  const result = await parseBody(req, updateE2EPasswordSchema);
  if (!result.ok) return result.response;

  const { encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, folderId, isFavorite, isArchived, entryType, requireReprompt, expiresAt } = result.data;

  // Verify folder ownership
  if (folderId) {
    const folder = await withTenantRls(prisma, tenantId, async () =>
      prisma.folder.findFirst({ where: { id: folderId, userId } }),
    );
    if (!folder) {
      return validationError("Invalid folderId");
    }
  }

  // Verify tag ownership
  if (tagIds?.length) {
    const ownedCount = await withTenantRls(prisma, tenantId, async () =>
      prisma.tag.count({ where: { id: { in: tagIds }, userId } }),
    );
    if (ownedCount !== tagIds.length) {
      return validationError("Invalid tagIds");
    }
  }

  const updateData: Record<string, unknown> = {};

  if (encryptedBlob) {
    updateData.encryptedBlob = encryptedBlob.ciphertext;
    updateData.blobIv = encryptedBlob.iv;
    updateData.blobAuthTag = encryptedBlob.authTag;
  }
  if (encryptedOverview) {
    updateData.encryptedOverview = encryptedOverview.ciphertext;
    updateData.overviewIv = encryptedOverview.iv;
    updateData.overviewAuthTag = encryptedOverview.authTag;
  }
  if (keyVersion !== undefined) updateData.keyVersion = keyVersion;
  if (aadVersion !== undefined) updateData.aadVersion = aadVersion;
  if (folderId !== undefined) updateData.folderId = folderId;
  if (isFavorite !== undefined) updateData.isFavorite = isFavorite;
  if (isArchived !== undefined) updateData.isArchived = isArchived;
  if (entryType !== undefined) updateData.entryType = entryType;
  if (requireReprompt !== undefined) updateData.requireReprompt = requireReprompt;
  if (expiresAt !== undefined) updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
  if (tagIds !== undefined) {
    updateData.tags = { set: tagIds.map((tid) => ({ id: tid })) };
  }

  // Snapshot history and update entry in a single transaction
  const updated = await withTenantRls(prisma, tenantId, async () =>
    prisma.$transaction(async (tx) => {
      if (encryptedBlob) {
        await tx.passwordEntryHistory.create({
          data: {
            entryId: id,
            tenantId: existing.tenantId,
            encryptedBlob: existing.encryptedBlob,
            blobIv: existing.blobIv,
            blobAuthTag: existing.blobAuthTag,
            keyVersion: existing.keyVersion,
            aadVersion: existing.aadVersion,
          },
        });
        // Trim to max 20 history entries (stable sort: changedAt asc, id asc)
        const all = await tx.passwordEntryHistory.findMany({
          where: { entryId: id },
          orderBy: [{ changedAt: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (all.length > 20) {
          await tx.passwordEntryHistory.deleteMany({
            where: { id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
          });
        }
      }
      return tx.passwordEntry.update({
        where: { id },
        data: updateData,
        include: { tags: { select: { id: true } } },
      });
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.ENTRY_UPDATE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
  });

  return NextResponse.json({
    id: updated.id,
    encryptedOverview: {
      ciphertext: updated.encryptedOverview,
      iv: updated.overviewIv,
      authTag: updated.overviewAuthTag,
    },
    keyVersion: updated.keyVersion,
    aadVersion: updated.aadVersion,
    entryType: updated.entryType,
    requireReprompt: updated.requireReprompt,
    expiresAt: updated.expiresAt,
    tagIds: updated.tags.map((t) => t.id),
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  });
}

// DELETE /api/v1/passwords/[id]
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkAuth(req, API_KEY_SCOPE.PASSWORDS_WRITE);
  if (!auth.ok) return auth.error;
  const { userId, tenantId } = auth.data;

  if (!userId) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED, message: "Service account tokens cannot access personal data via v1 API. Use MCP Gateway." },
      { status: 403 },
    );
  }

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const { id } = await params;

  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  const existing = await withTenantRls(prisma, tenantId, async () =>
    prisma.passwordEntry.findUnique({ where: { id }, select: { userId: true } }),
  );

  if (!existing || existing.userId !== userId) {
    return notFound();
  }

  if (permanent) {
    await withTenantRls(prisma, tenantId, async () =>
      prisma.passwordEntry.delete({ where: { id } }),
    );
  } else {
    await withTenantRls(prisma, tenantId, async () =>
      prisma.passwordEntry.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    );
  }

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: permanent ? AUDIT_ACTION.ENTRY_PERMANENT_DELETE : AUDIT_ACTION.ENTRY_TRASH,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
    metadata: { permanent },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
