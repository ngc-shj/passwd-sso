import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit";
import { createE2EPasswordSchema } from "@/lib/validations";
import { rateLimited, validationError } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { checkAuth } from "@/lib/check-auth";
import { withRequestLog } from "@/lib/with-request-log";
import type { EntryType } from "@prisma/client";
import { ENTRY_TYPE_VALUES, EXTENSION_TOKEN_SCOPE, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { toBlobColumns, toOverviewColumns } from "@/lib/crypto-blob";
import { FILENAME_MAX_LENGTH } from "@/lib/validations/common";
import { createRateLimiter } from "@/lib/rate-limit";

import { withUserTenantRls } from "@/lib/tenant-context";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma-filters";
import { getAttachmentBlobStore, BLOB_STORAGE } from "@/lib/blob-store";
import { MS_PER_DAY } from "@/lib/constants/time";

const VALID_ENTRY_TYPES: Set<string> = new Set(ENTRY_TYPE_VALUES);

const listLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const createLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

// GET /api/passwords - List passwords (returns encrypted overviews)
async function handleGET(req: NextRequest) {
  const authed = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_READ });
  if (!authed.ok) return authed.response;
  const { userId } = authed.auth;

  const rl = await listLimiter.check(`rl:passwords_list:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const { searchParams } = new URL(req.url);
  const tagId = searchParams.get("tag");
  const rawType = searchParams.get("type");
  const entryType = rawType && VALID_ENTRY_TYPES.has(rawType) ? (rawType as EntryType) : null;
  const includeBlob = searchParams.get("include") === "blob";
  const favoritesOnly = searchParams.get("favorites") === "true";
  const trashOnly = searchParams.get("trash") === "true";
  const archivedOnly = searchParams.get("archived") === "true";
  const folderId = searchParams.get("folder");

  const passwords = await withUserTenantRls(userId, async () =>
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

  // Auto-purge items deleted more than 30 days ago
  if (!trashOnly) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY);
    await withUserTenantRls(userId, async () => {
      // Cap per-request cleanup to avoid pathological cases (very old users with
      // thousands of trashed entries); remaining entries purged on next load.
      const staleEntries = await prisma.passwordEntry.findMany({
        where: { userId, deletedAt: { lt: thirtyDaysAgo } },
        select: { id: true },
        take: 500,
      });
      if (staleEntries.length === 0) return;

      // Clean up external blob-store objects before cascade delete
      const blobStore = getAttachmentBlobStore();
      if (blobStore.backend !== BLOB_STORAGE.DB) {
        const attachments = await prisma.attachment.findMany({
          where: { passwordEntryId: { in: staleEntries.map((e) => e.id) } },
          select: { id: true, encryptedData: true, passwordEntryId: true },
        });
        await Promise.allSettled(
          attachments.map((a) =>
            blobStore.deleteObject(a.encryptedData, {
              attachmentId: a.id,
              entryId: a.passwordEntryId!,
            }),
          ),
        );
      }

      await prisma.passwordEntry.deleteMany({
        where: { id: { in: staleEntries.map((e) => e.id) } },
      });
    }).catch(() => {});
  }

  // Return encrypted overviews (and optionally blobs) for client-side decryption
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

// POST /api/passwords - Create new password entry (E2E encrypted)
async function handlePOST(req: NextRequest) {
  const authed = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE });
  if (!authed.ok) return authed.response;
  const { userId } = authed.auth;

  const rl = await createLimiter.check(`rl:passwords_create:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, createE2EPasswordSchema);
  if (!result.ok) return result.response;

  const { id: clientId, encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, folderId, isFavorite, entryType, requireReprompt, expiresAt } = result.data;

  const createResult = await withUserTenantRls(userId, async (tenantId) => {
    // Verify folder ownership
    if (folderId) {
      const folder = await prisma.folder.findFirst({ where: { id: folderId, userId } });
      if (!folder) {
        return { error: "INVALID_FOLDER" as const };
      }
    }

    // Verify tag ownership
    if (tagIds?.length) {
      const ownedCount = await prisma.tag.count({ where: { id: { in: tagIds }, userId } });
      if (ownedCount !== tagIds.length) {
        return { error: "INVALID_TAGS" as const };
      }
    }

    const entry = await prisma.passwordEntry.create({
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
    return validationError(detail);
  }

  const { entry } = createResult;

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.ENTRY_CREATE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: entry.id,
    metadata: (() => {
      if (req.headers.get("x-passwd-sso-source") !== "import") return undefined;
      const rawFilename = req.headers.get("x-passwd-sso-filename")?.trim() ?? "";
      const filename = rawFilename
        ? rawFilename
            .replace(/[\0\x01-\x1f\x7f-\x9f]/g, "") // null bytes + control chars
            .replace(/[/\\]/g, "_")                    // path separators → underscore
            .trim()
            .slice(0, FILENAME_MAX_LENGTH) || undefined
        : undefined;
      return filename
        ? {
            source: "import",
            filename,
            parentAction: AUDIT_ACTION.ENTRY_IMPORT,
          }
        : {
            source: "import",
            parentAction: AUDIT_ACTION.ENTRY_IMPORT,
          };
    })(),
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
    { status: 201 }
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
