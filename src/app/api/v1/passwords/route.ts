import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createE2EPasswordSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { validateApiKeyOnly } from "@/lib/api-key";
import { withRequestLog } from "@/lib/with-request-log";
import { withTenantRls } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_KEY_SCOPE } from "@/lib/constants/api-key";
import { ENTRY_TYPE_VALUES, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { enforceAccessRestriction } from "@/lib/access-restriction";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma-filters";
import type { EntryType } from "@prisma/client";
import { unauthorized } from "@/lib/api-response";

const VALID_ENTRY_TYPES: Set<string> = new Set(ENTRY_TYPE_VALUES);

const apiKeyLimiter = createRateLimiter({ windowMs: 60_000, max: 100 });

function retryAfterHeaders(ms: number): HeadersInit {
  return { "Retry-After": String(Math.ceil(ms / 1000)) };
}

// GET /api/v1/passwords — List passwords (API key only)
async function handleGET(req: NextRequest) {
  const authResult = await validateApiKeyOnly(req, API_KEY_SCOPE.PASSWORDS_READ);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return NextResponse.json(
        { error: API_ERROR.API_KEY_SCOPE_INSUFFICIENT },
        { status: 403 },
      );
    }
    return unauthorized();
  }

  const { userId, tenantId, apiKeyId } = authResult.data;

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const rl = await apiKeyLimiter.check(`rl:api_key:${apiKeyId}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429, headers: retryAfterHeaders(rl.retryAfterMs!) },
    );
  }

  const { searchParams } = new URL(req.url);
  const tagId = searchParams.get("tag");
  const rawType = searchParams.get("type");
  const entryType = rawType && VALID_ENTRY_TYPES.has(rawType) ? (rawType as EntryType) : null;
  const includeBlob = searchParams.get("include") === "blob";
  const favoritesOnly = searchParams.get("favorites") === "true";
  const trashOnly = searchParams.get("trash") === "true";
  const archivedOnly = searchParams.get("archived") === "true";
  const folderId = searchParams.get("folder");

  const passwords = await withTenantRls(prisma, tenantId, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId,
        ...(trashOnly
          ? { deletedAt: { not: null } }
          : archivedOnly
            ? { deletedAt: null, isArchived: true }
            : { ...ACTIVE_ENTRY_WHERE }),
        ...(favoritesOnly ? { isFavorite: true } : {}),
        ...(tagId ? { tags: { some: { id: tagId } } } : {}),
        ...(entryType ? { entryType } : {}),
        ...(folderId ? { folderId } : {}),
      },
      include: { tags: { select: { id: true } } },
      orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }],
    }),
  );

  const entries = passwords.map((entry) => ({
    id: entry.id,
    encryptedOverview: {
      ciphertext: entry.encryptedOverview,
      iv: entry.overviewIv,
      authTag: entry.overviewAuthTag,
    },
    ...(includeBlob
      ? {
          encryptedBlob: {
            ciphertext: entry.encryptedBlob,
            iv: entry.blobIv,
            authTag: entry.blobAuthTag,
          },
        }
      : {}),
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
    deletedAt: entry.deletedAt,
  }));

  return NextResponse.json(entries);
}

// POST /api/v1/passwords — Create password (API key only)
async function handlePOST(req: NextRequest) {
  const authResult = await validateApiKeyOnly(req, API_KEY_SCOPE.PASSWORDS_WRITE);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return NextResponse.json(
        { error: API_ERROR.API_KEY_SCOPE_INSUFFICIENT },
        { status: 403 },
      );
    }
    return unauthorized();
  }

  const { userId, tenantId, apiKeyId } = authResult.data;

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const rl = await apiKeyLimiter.check(`rl:api_key:${apiKeyId}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429, headers: retryAfterHeaders(rl.retryAfterMs!) },
    );
  }

  const result = await parseBody(req, createE2EPasswordSchema);
  if (!result.ok) return result.response;

  const { id: clientId, encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, folderId, isFavorite, entryType, requireReprompt, expiresAt } = result.data;

  const createResult = await withTenantRls(prisma, tenantId, async () => {
    if (folderId) {
      const folder = await prisma.folder.findFirst({ where: { id: folderId, userId } });
      if (!folder) return { error: "INVALID_FOLDER" as const };
    }

    if (tagIds?.length) {
      const ownedCount = await prisma.tag.count({ where: { id: { in: tagIds }, userId } });
      if (ownedCount !== tagIds.length) return { error: "INVALID_TAGS" as const };
    }

    const entry = await prisma.passwordEntry.create({
      data: {
        ...(clientId ? { id: clientId } : {}),
        encryptedBlob: encryptedBlob.ciphertext,
        blobIv: encryptedBlob.iv,
        blobAuthTag: encryptedBlob.authTag,
        encryptedOverview: encryptedOverview.ciphertext,
        overviewIv: encryptedOverview.iv,
        overviewAuthTag: encryptedOverview.authTag,
        keyVersion,
        aadVersion,
        entryType,
        ...(isFavorite !== undefined ? { isFavorite } : {}),
        ...(requireReprompt !== undefined ? { requireReprompt } : {}),
        ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
        ...(folderId ? { folderId } : {}),
        userId,
        tenantId,
        ...(tagIds?.length
          ? { tags: { connect: tagIds.map((id) => ({ id })) } }
          : {}),
      },
      include: { tags: { select: { id: true } } },
    });

    return { entry };
  });

  if ("error" in createResult) {
    const detail = createResult.error === "INVALID_FOLDER" ? "Invalid folderId" : "Invalid tagIds";
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: detail },
      { status: 400 },
    );
  }

  const { entry } = createResult;

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_CREATE,
    userId,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: entry.id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      id: entry.id,
      encryptedOverview: {
        ciphertext: entry.encryptedOverview,
        iv: entry.overviewIv,
        authTag: entry.overviewAuthTag,
      },
      keyVersion: entry.keyVersion,
      aadVersion: entry.aadVersion,
      entryType: entry.entryType,
      requireReprompt: entry.requireReprompt,
      expiresAt: entry.expiresAt,
      tagIds: entry.tags.map((t) => t.id),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    { status: 201 },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
