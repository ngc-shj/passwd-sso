import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { activeTeamRole, hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { logAuditInTx, teamAuditBase } from "@/lib/audit/audit";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { errorResponse, handleAuthError, notFound, rateLimited, unauthorized } from "@/lib/http/api-response";
import { teamAttachmentMigrateLimiter } from "@/lib/security/rate-limiters";
import {
  ATTACHMENT_BODY_BASE64_MAX,
  ATTACHMENT_MIGRATE_PAYLOAD_MAX,
  BASE64_RE,
  CEK_WRAP_BASE64_MAX,
  FILENAME_MAX_LENGTH,
  MAX_FILE_SIZE,
  hexAuthTag,
  hexHash,
  hexIv,
} from "@/lib/validations/common";
import { AAD_VERSION, CURRENT_CEK_WRAP_AAD_VERSION } from "@/lib/crypto/crypto-aad";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { deleteAttachmentBlobs } from "@/lib/blob-store/cleanup";
import {
  BlobRefInvalidError,
  newBlobGeneration,
  resolveObjectRefKey,
} from "@/lib/blob-store/object-ref";
import { BLOB_STORAGE } from "@/lib/blob-store/types";
import { TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";
import { lockTeamAttachmentEntry, lockTeamAttachmentRow } from "@/lib/team/team-attachment-lock";
import { itemKeyIdsMatch } from "@/lib/team/team-item-key";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ teamId: string; id: string; attachmentId: string }>;
};

// A legacy (mode 0/1) attachment re-encrypted by the client under a fresh CEK
// wrapped with the entry's ItemKey (plan C4). `snapshot` is the row's iv and
// authTag the client decrypted, `clientHash` the SHA-256 of the stored
// ciphertext it decrypted; filename, contentType and sizeBytes must be the
// row's own (a migrate re-encrypts, it does not edit).
const teamAttachmentMigrateSchema = z.object({
  itemKeyId: z.string().uuid(),
  cekKeyVersion: z.number().int().min(1),
  snapshot: z.object({ iv: hexIv, authTag: hexAuthTag }).strict(),
  clientHash: hexHash,
  encryptedData: z.string().min(1).max(ATTACHMENT_BODY_BASE64_MAX).regex(BASE64_RE),
  iv: hexIv,
  authTag: hexAuthTag,
  cekEncrypted: z.string().min(1).max(CEK_WRAP_BASE64_MAX).regex(BASE64_RE),
  cekIv: hexIv,
  cekAuthTag: hexAuthTag,
  cekWrapAadVersion: z.literal(CURRENT_CEK_WRAP_AAD_VERSION),
  filename: z.string().min(1).max(FILENAME_MAX_LENGTH),
  contentType: z.string().min(1).max(100),
  sizeBytes: z.number().int().min(1).max(MAX_FILE_SIZE),
  aadVersion: z.literal(AAD_VERSION),
}).strict();

type MigrateOutcome =
  | { ok: true; oldStored: Uint8Array }
  | { ok: false; code: ApiErrorCode };

// PUT /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/migrate
// Migrates one legacy (mode 0/1) team attachment to mode 2 (CEK wrapped under
// the entry's ItemKey), so the re-key pass can re-wrap its CEK.
async function handlePUT(req: NextRequest, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const { teamId, id: entryId, attachmentId } = await params;

  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // @stepup id:team-attachment-migrate-put method:PUT
  const stepUpError = await requireRecentCurrentAuthMethod(req, userId);
  if (stepUpError) return stepUpError;

  const rl = await teamAttachmentMigrateLimiter.check(`rl:team_attachment_migrate:${teamId}:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id: entryId },
      select: { teamId: true },
    }),
  );
  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const parsed = await parseBody(req, teamAttachmentMigrateSchema, {
    maxBytes: ATTACHMENT_MIGRATE_PAYLOAD_MAX,
  });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // Read the stored ciphertext before the transaction (no storage I/O is done
  // while holding row locks). Its hash and length are used under the locks
  // only if the locked row still holds the ref (and iv/authTag) read here —
  // objects are immutable per generation, so the same ref names the same
  // bytes.
  const blobContext = { attachmentId, entryId, teamId };
  const current = await withTeamTenantRls(teamId, async () =>
    prisma.attachment.findUnique({
      where: { id: attachmentId, teamPasswordEntryId: entryId },
      select: { encryptedData: true, iv: true, authTag: true, encryptionMode: true },
    }),
  );
  if (!current) {
    return errorResponse(API_ERROR.ATTACHMENT_NOT_FOUND);
  }
  const blobStore = getAttachmentBlobStore();
  let stored: { hash: string; length: number } | null = null;
  if (current.encryptionMode !== 2) {
    try {
      const bytes = await blobStore.getObject(current.encryptedData, blobContext);
      stored = { hash: createHash("sha256").update(bytes).digest("hex"), length: bytes.length };
    } catch (e) {
      // Reported in the refusal order below (after MIGRATE_NOT_LEGACY).
      if (!(e instanceof BlobRefInvalidError)) throw e;
    }
  }

  // The new body goes to a fresh object before the transaction; it is deleted
  // on every outcome but a commit.
  const newBody = Buffer.from(body.encryptedData, "base64");
  const newContext = { ...blobContext, generation: newBlobGeneration() };
  const newStored = await blobStore.putObject(newBody, newContext);

  let outcome: MigrateOutcome;
  try {
    outcome = await withTeamTenantRls(teamId, async (tenantId, tx): Promise<MigrateOutcome> => {
      // Lock order: team FOR SHARE → entry FOR SHARE → attachment FOR UPDATE.
      let locked;
      try {
        locked = await lockTeamAttachmentEntry(tx, teamId, entryId);
      } catch (e) {
        if (e instanceof TeamRotationInProgressError) {
          return { ok: false, code: API_ERROR.TEAM_KEY_VERSION_MISMATCH };
        }
        throw e;
      }
      if (!locked) return { ok: false, code: API_ERROR.NOT_FOUND };
      const row = await lockTeamAttachmentRow(tx, entryId, attachmentId);
      if (!row) return { ok: false, code: API_ERROR.ATTACHMENT_NOT_FOUND };

      // The actor's authority, under the team lock: a removal or demotion
      // committed since requireTeamPermission would otherwise still let them
      // rewrite the attachment.
      const role = await activeTeamRole(tx, teamId, userId);
      if (!role || !hasTeamPermission(role, TEAM_PERMISSION.TEAM_UPDATE)) {
        return { ok: false, code: API_ERROR.ACTOR_NOT_PERMITTED };
      }

      if (row.encryptionMode === 2) {
        return { ok: false, code: API_ERROR.MIGRATE_NOT_LEGACY };
      }
      if (locked.itemKeyVersion === 0) {
        return { ok: false, code: API_ERROR.ENTRY_UPGRADE_REQUIRED };
      }
      if (!itemKeyIdsMatch(body.itemKeyId, locked.itemKeyId)) {
        return { ok: false, code: API_ERROR.ITEM_KEY_CHANGED };
      }
      if (body.cekKeyVersion !== locked.itemKeyVersion) {
        return { ok: false, code: API_ERROR.CEK_KEY_VERSION_MISMATCH };
      }
      // The client decrypted the ciphertext these name: the GCM tag binds the
      // ciphertext and every rewrite uses a fresh IV.
      if (body.snapshot.iv !== row.iv || body.snapshot.authTag !== row.authTag) {
        return { ok: false, code: API_ERROR.MIGRATE_CAS_FAILED };
      }
      if (blobStore.backend !== BLOB_STORAGE.DB) {
        try {
          resolveObjectRefKey(row.encryptedData, blobContext);
        } catch (e) {
          if (e instanceof BlobRefInvalidError) return { ok: false, code: API_ERROR.BLOB_REF_INVALID };
          throw e;
        }
      }
      // The hash below is over what was read before the transaction: valid
      // only while the locked row is the row that was read.
      if (
        !stored ||
        row.iv !== current.iv ||
        row.authTag !== current.authTag ||
        !Buffer.from(row.encryptedData).equals(Buffer.from(current.encryptedData))
      ) {
        return { ok: false, code: API_ERROR.MIGRATE_CAS_FAILED };
      }
      if (body.clientHash !== stored.hash) {
        return { ok: false, code: API_ERROR.MIGRATE_HASH_MISMATCH };
      }
      // AES-GCM preserves the plaintext length: re-encrypting the same body
      // yields a ciphertext of the same byte length.
      if (newBody.length !== stored.length) {
        return { ok: false, code: API_ERROR.MIGRATE_LENGTH_CHANGED };
      }
      if (
        body.filename !== row.filename ||
        body.contentType !== row.contentType ||
        body.sizeBytes !== row.sizeBytes
      ) {
        return { ok: false, code: API_ERROR.MIGRATE_METADATA_CHANGED };
      }

      await tx.attachment.update({
        where: { id: attachmentId, teamPasswordEntryId: entryId },
        data: {
          encryptedData: Buffer.from(newStored),
          iv: body.iv,
          authTag: body.authTag,
          aadVersion: body.aadVersion,
          keyVersion: locked.teamKeyVersion,
          encryptionMode: 2,
          cekEncrypted: Buffer.from(body.cekEncrypted, "base64"),
          cekIv: body.cekIv,
          cekAuthTag: body.cekAuthTag,
          cekKeyVersion: body.cekKeyVersion,
          cekWrapAadVersion: body.cekWrapAadVersion,
          // From the locked row, never from the client.
          cekItemKeyId: locked.itemKeyId,
        },
      });
      await logAuditInTx(tx, tenantId, {
        ...teamAuditBase(req, userId, teamId),
        action: AUDIT_ACTION.TEAM_ATTACHMENT_MIGRATE,
        targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
        targetId: attachmentId,
        metadata: {
          entryId,
          fromEncryptionMode: row.encryptionMode,
          toItemKeyVersion: locked.itemKeyVersion,
        },
      });
      return { ok: true, oldStored: row.encryptedData };
    });
  } catch (e) {
    await blobStore.deleteObject(newStored, newContext).catch(() => {});
    throw e;
  }

  if (!outcome.ok) {
    await blobStore.deleteObject(newStored, newContext).catch(() => {});
    return outcome.code === API_ERROR.NOT_FOUND ? notFound() : errorResponse(outcome.code);
  }

  // The old object is unreferenced once the row commits.
  await deleteAttachmentBlobs([{ stored: outcome.oldStored, context: blobContext }]);

  return NextResponse.json({ success: true, attachmentId, encryptionMode: 2 });
}

export const PUT = withRequestLog(handlePUT);
