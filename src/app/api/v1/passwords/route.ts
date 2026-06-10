import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { createE2EPasswordSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { validateV1Auth } from "@/lib/auth/session/v1-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withTenantRls } from "@/lib/tenant-rls";
import { v1ApiKeyLimiter } from "@/lib/security/rate-limiters";
import { API_KEY_SCOPE } from "@/lib/constants/auth/api-key";
import { ENTRY_TYPE_VALUES, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { toBlobColumns, toOverviewColumns } from "@/lib/crypto/crypto-blob";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma/prisma-filters";
import type { EntryType } from "@prisma/client";
import { errorResponse, errorResponseWithMessage, rateLimited, unauthorized } from "@/lib/http/api-response";

const VALID_ENTRY_TYPES: Set<string> = new Set(ENTRY_TYPE_VALUES);


// GET /api/v1/passwords — List passwords (API key or SA token)
async function handleGET(req: NextRequest) {
  const authResult = await validateV1Auth(req, API_KEY_SCOPE.PASSWORDS_READ);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return errorResponse(API_ERROR.API_KEY_SCOPE_INSUFFICIENT);
    }
    return unauthorized();
  }

  const { userId, tenantId, rateLimitKey } = authResult.data;

  if (!userId) {
    return errorResponseWithMessage(API_ERROR.FORBIDDEN, "Service account tokens cannot access personal data via v1 API. Use MCP Gateway.");
  }

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const rl = await v1ApiKeyLimiter.check(`rl:api_key:${rateLimitKey}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
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

  const passwords = await withTenantRls(prisma, tenantId, async (tx) =>
    tx.passwordEntry.findMany({
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

// POST /api/v1/passwords — Create password (API key or SA token)
async function handlePOST(req: NextRequest) {
  const authResult = await validateV1Auth(req, API_KEY_SCOPE.PASSWORDS_WRITE);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return errorResponse(API_ERROR.API_KEY_SCOPE_INSUFFICIENT);
    }
    return unauthorized();
  }

  const { userId, tenantId, rateLimitKey } = authResult.data;

  if (!userId) {
    return errorResponseWithMessage(API_ERROR.FORBIDDEN, "Service account tokens cannot access personal data via v1 API. Use MCP Gateway.");
  }

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const rl = await v1ApiKeyLimiter.check(`rl:api_key:${rateLimitKey}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, createE2EPasswordSchema);
  if (!result.ok) return result.response;

  const { id: clientId, encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, folderId, isFavorite, entryType, requireReprompt, expiresAt } = result.data;

  const createResult = await withTenantRls(prisma, tenantId, async (tx) => {
    if (folderId) {
      const folder = await tx.folder.findFirst({ where: { id: folderId, userId } });
      if (!folder) return { error: "INVALID_FOLDER" as const };
    }

    // Normalize duplicates: a caller-supplied duplicate (e.g. ["t1","t1"])
    // should not count as a missing tag — tag.count returns distinct row count,
    // so compare against the deduped input length, not the raw array length.
    // Mirrors team-password-service.ts.
    if (tagIds?.length) {
      const uniqueTagIds = [...new Set(tagIds)];
      const ownedCount = await tx.tag.count({ where: { id: { in: uniqueTagIds }, userId } });
      if (ownedCount !== uniqueTagIds.length) return { error: "INVALID_TAGS" as const };
    }

    const entry = await tx.passwordEntry.create({
      data: {
        ...(clientId ? { id: clientId } : {}),
        ...toBlobColumns(encryptedBlob),
        ...toOverviewColumns(encryptedOverview),
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
    return errorResponseWithMessage(API_ERROR.VALIDATION_ERROR, detail);
  }

  const { entry } = createResult;

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.ENTRY_CREATE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: entry.id,
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
