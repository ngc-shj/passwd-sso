import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, logAuditBatch, extractRequestMeta } from "@/lib/audit";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { unauthorized } from "@/lib/api-response";
import { rateLimited } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { bulkImportSchema } from "@/lib/validations";
import { createRateLimiter } from "@/lib/rate-limit";
import { FILENAME_MAX_LENGTH } from "@/lib/validations/common";

const bulkImportLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

// POST /api/passwords/bulk-import - Bulk create password entries (E2E encrypted)
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const rl = await bulkImportLimiter.check(`rl:passwords_bulk_import:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, bulkImportSchema);
  if (!result.ok) return result.response;

  const { entries, sourceFilename } = result.data;

  const sanitizedFilename = sourceFilename
    ? sourceFilename
        .replace(/[\0\x01-\x1f\x7f-\x9f]/g, "")
        .replace(/[/\\]/g, "_")
        .trim()
        .slice(0, FILENAME_MAX_LENGTH) || undefined
    : undefined;

  const createdIds: string[] = [];
  let failedCount = 0;
  let actorMissing = false;

  await withUserTenantRls(userId, async () => {
    const actor = await prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    if (!actor) {
      actorMissing = true;
      return;
    }

    for (const entryData of entries) {
      try {
        const {
          id: clientId,
          encryptedBlob,
          encryptedOverview,
          keyVersion,
          aadVersion,
          tagIds,
          folderId,
          isFavorite,
          entryType,
          requireReprompt,
          expiresAt,
        } = entryData;

        // Verify folder ownership
        if (folderId) {
          const folder = await prisma.folder.findFirst({ where: { id: folderId, userId } });
          if (!folder) {
            failedCount++;
            continue;
          }
        }

        // Verify tag ownership
        if (tagIds?.length) {
          const ownedCount = await prisma.tag.count({ where: { id: { in: tagIds }, userId } });
          if (ownedCount !== tagIds.length) {
            failedCount++;
            continue;
          }
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
            tenantId: actor.tenantId,
            ...(tagIds?.length
              ? { tags: { connect: tagIds.map((id) => ({ id })) } }
              : {}),
          },
          select: { id: true },
        });

        createdIds.push(entry.id);
      } catch {
        failedCount++;
      }
    }
  });

  if (actorMissing) return unauthorized();

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_BULK_IMPORT,
    userId,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    // targetId omitted for bulk operations
    metadata: {
      bulk: true,
      requestedCount: entries.length,
      createdCount: createdIds.length,
      failedCount,
      ...(sanitizedFilename ? { filename: sanitizedFilename } : {}),
    },
    ...requestMeta,
  });

  logAuditBatch(
    createdIds.map((entryId) => ({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-import",
        parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT,
      },
      ...requestMeta,
    })),
  );

  return NextResponse.json(
    { success: createdIds.length, failed: failedCount },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
