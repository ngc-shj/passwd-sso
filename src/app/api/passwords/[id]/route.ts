import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  collectEntryAttachmentRefs,
  deleteAttachmentBlobs,
} from "@/lib/blob-store/cleanup";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { updateE2EPasswordSchema } from "@/lib/validations";
import { errorResponse, notFound, rateLimited, validationError } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { checkAuth } from "@/lib/auth/session/check-auth";
import { parseBody } from "@/lib/http/parse-body";
import { createRateLimiter } from "@/lib/security/rate-limit";

import { withRequestLog } from "@/lib/http/with-request-log";
import { EXTENSION_TOKEN_SCOPE, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

const getLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 60 });
const updateLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 30 });

// GET /api/passwords/[id] - Get password detail (returns encrypted blob)
async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_READ });
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult.auth;

  const rl = await getLimiter.check(`rl:passwords_get:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const { id } = await params;

  const entry = await withUserTenantRls(userId, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      include: { tags: { select: { id: true } } },
    }),
  );

  if (!entry) {
    return notFound();
  }

  if (entry.userId !== userId) {
    // A01-4: 403 vs 404 difference leaks "ID exists in tenant" oracle to
    // attacker. RLS should already null this branch; defense-in-depth.
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

// PUT /api/passwords/[id] - Update password entry (E2E encrypted)
async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE });
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult.auth;

  const rl = await updateLimiter.check(`rl:passwords_update:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const { id } = await params;

  const existing = await withUserTenantRls(userId, async () =>
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

  if (!existing) {
    return notFound();
  }

  if (existing.userId !== userId) {
    // A01-4: collapse 403 → 404 to remove existence oracle.
    return notFound();
  }

  const result = await parseBody(req, updateE2EPasswordSchema);
  if (!result.ok) return result.response;

  const { encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, folderId, isFavorite, isArchived, entryType, requireReprompt, expiresAt } = result.data;

  // Verify folder ownership
  if (folderId) {
    const folder = await withUserTenantRls(userId, async () =>
      prisma.folder.findFirst({ where: { id: folderId, userId } }),
    );
    if (!folder) {
      return validationError({ message: "Invalid folderId" });
    }
  }

  // Verify tag ownership. Normalize duplicates first: a caller-supplied
  // duplicate (e.g. ["t1","t1"]) should not count as a missing tag —
  // tag.count returns distinct row count, so compare against the deduped
  // input length, not the raw array length. Mirrors team-password-service.ts.
  if (tagIds?.length) {
    const uniqueTagIds = [...new Set(tagIds)];
    const ownedCount = await withUserTenantRls(userId, async () =>
      prisma.tag.count({ where: { id: { in: uniqueTagIds }, userId } }),
    );
    if (ownedCount !== uniqueTagIds.length) {
      return validationError({ message: "Invalid tagIds" });
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
  // C7: keyVersion / aadVersion cannot change without re-encryption.
  // If either differs from the stored value and encryptedBlob is absent, reject.
  const keyVersionChanged = keyVersion !== undefined && keyVersion !== existing.keyVersion;
  const aadVersionChanged = aadVersion !== undefined && aadVersion !== existing.aadVersion;
  if ((keyVersionChanged || aadVersionChanged) && !encryptedBlob) {
    return errorResponse(API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT);
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

  // Row type for the FOR UPDATE snapshot read (personal password_entries).
  type PersonalBlobRow = {
    encrypted_blob: string;
    blob_iv: string;
    blob_auth_tag: string;
    key_version: number;
    aad_version: number;
  };

  // If the blob is changing, snapshot + update must be atomic and lost-update-safe:
  // acquire a PK row lock inside the same tenant-scoped transaction so concurrent
  // PUTs serialise here and each writer snapshots the immediately-preceding committed
  // blob (not the outside-tx `existing` read, which may be stale under contention).
  const updated = await (encryptedBlob
    ? withUserTenantRls(userId, async () =>
        prisma.$transaction(async (tx) => {
          const [cur] = await tx.$queryRaw<PersonalBlobRow[]>`
            SELECT encrypted_blob, blob_iv, blob_auth_tag, key_version, aad_version
            FROM password_entries
            WHERE id = ${id}::uuid
            FOR UPDATE
          `;
          // Entry may be concurrently deleted between the early read and this lock.
          if (!cur) return null;
          // Snapshot the current committed blob into history
          await tx.passwordEntryHistory.create({
            data: {
              entryId: id,
              tenantId: existing.tenantId,
              encryptedBlob: cur.encrypted_blob,
              blobIv: cur.blob_iv,
              blobAuthTag: cur.blob_auth_tag,
              keyVersion: cur.key_version,
              aadVersion: cur.aad_version,
            },
          });
          // Trim to max 20 entries (stable sort: changedAt asc, id asc)
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
          return tx.passwordEntry.update({
            where: { id },
            data: updateData,
            include: { tags: { select: { id: true } } },
          });
        }),
      )
    : withUserTenantRls(userId, async () =>
        prisma.passwordEntry.update({
          where: { id },
          data: updateData,
          include: { tags: { select: { id: true } } },
        }),
      ));

  // Null sentinel: the blob-tx path returns null when the entry was concurrently
  // deleted between the early findUnique and the FOR UPDATE lock.
  if (!updated) return notFound();

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

// DELETE /api/passwords/[id] - Soft delete (move to trash)
// Session-only: token support for deletion deferred to Phase E (requires PASSWORDS_DELETE scope)
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await checkAuth(req);
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult.auth;

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  // A01-3: permanent delete is unrecoverable. Require fresh credential
  // possession (15-min step-up window) so a leaked session cookie alone
  // cannot wipe entries. Soft-delete (trash) remains gated only by
  // session — the trash itself acts as a recovery window.
  if (permanent) {
    const stepUp = await requireRecentCurrentAuthMethod(req);
    if (stepUp) return stepUp;
  }

  const existing = await withUserTenantRls(userId, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: { userId: true },
    }),
  );

  if (!existing) {
    return notFound();
  }

  if (existing.userId !== userId) {
    // A01-4: collapse 403 → 404 to remove existence oracle.
    return notFound();
  }

  if (permanent) {
    const refs = await withUserTenantRls(userId, async () => {
      // Capture external blob refs before the cascade delete removes the rows
      const attachmentRefs = await collectEntryAttachmentRefs(prisma, {
        kind: "personal",
        entryIds: [id],
      });
      await prisma.passwordEntry.delete({ where: { id } });
      return attachmentRefs;
    });
    await deleteAttachmentBlobs(refs);
  } else {
    await withUserTenantRls(userId, async () =>
      prisma.passwordEntry.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    );
  }

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: permanent
      ? AUDIT_ACTION.ENTRY_PERMANENT_DELETE
      : AUDIT_ACTION.ENTRY_TRASH,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
    metadata: { permanent },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
