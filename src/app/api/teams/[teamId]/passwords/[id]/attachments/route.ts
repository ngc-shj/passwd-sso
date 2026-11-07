import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { advisoryXactLock } from "@/lib/tenant-rls";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { activeTeamRole, canWriteTeamEntry, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { newBlobGeneration } from "@/lib/blob-store/object-ref";
import { AUDIT_TARGET_TYPE, TEAM_PERMISSION, AUDIT_ACTION, ATTACHMENT_ENCRYPTION_MODE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
  FILENAME_MAX_LENGTH,
  isValidSendFilename,
} from "@/lib/validations";
import {
  ATTACHMENT_UPLOAD_MULTIPART_MAX,
  BASE64_RE,
  CEK_WRAP_BASE64_MAX,
} from "@/lib/validations/common";
import { CURRENT_CEK_WRAP_AAD_VERSION } from "@/lib/crypto/crypto-aad";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rejectOversizedMultipart } from "@/lib/http/parse-body";
import { errorResponse, handleAuthError, notFound, rateLimited, unauthorized, validationError } from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";
import { lockTeamAttachmentEntry } from "@/lib/team/team-attachment-lock";
import { itemKeyIdsMatch, normalizeTeamKeyVersion } from "@/lib/team/team-item-key";

type RouteContext = { params: Promise<{ teamId: string; id: string }> };

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreatedAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
};

type UploadOutcome =
  | { ok: true; attachment: CreatedAttachment }
  | { ok: false; code: ApiErrorCode };

const teamAttachmentUploadLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 30 });

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

// GET /api/teams/[teamId]/passwords/[id]/attachments - List attachment metadata
async function handleGET(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true, tenantId: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const attachments = await withTeamTenantRls(teamId, async () =>
    prisma.attachment.findMany({
      where: { teamPasswordEntryId: id },
      select: {
        id: true,
        filename: true,
        contentType: true,
        sizeBytes: true,
        encryptionMode: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json(attachments);
}

// POST /api/teams/[teamId]/passwords/[id]/attachments - Upload attachment (client-side encrypted)
async function handlePOST(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  let membership;
  try {
    membership = await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const rl = await teamAttachmentUploadLimiter.check(`rl:team_attachment_upload:${session.user.id}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  // Pre-check only (existence, own-entry rule). The entry's ItemKey identity
  // and creator are read again under the locks in the transaction below.
  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true, createdById: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }
  if (!canWriteTeamEntry(membership.role, entry.createdById, session.user.id)) {
    return errorResponse(API_ERROR.ONLY_OWN_ENTRIES);
  }

  // Early rejection before buffering the multipart body into memory. Requires a
  // declared Content-Length and caps it — fail-closed on a missing header so a
  // chunked / no-Content-Length body cannot bypass the cap (req.formData() has
  // no streaming cap of its own).
  const oversized = rejectOversizedMultipart(req, ATTACHMENT_UPLOAD_MULTIPART_MAX);
  if (oversized) return oversized;

  // Parse FormData
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse(API_ERROR.INVALID_FORM_DATA);
  }

  const clientId = formData.get("id") as string | null;
  const file = formData.get("file") as File | null;
  const iv = formData.get("iv") as string | null;
  const authTag = formData.get("authTag") as string | null;
  const filename = formData.get("filename") as string | null;
  const contentType = formData.get("contentType") as string | null;
  const sizeBytes = formData.get("sizeBytes") as string | null;
  const aadVersionStr = formData.get("aadVersion") as string | null;
  const encryptionModeStr = formData.get("encryptionMode") as string | null;
  const itemKeyId = formData.get("itemKeyId") as string | null;
  const cekKeyVersionStr = formData.get("cekKeyVersion") as string | null;
  const cekEncrypted = formData.get("cekEncrypted") as string | null;
  const cekIv = formData.get("cekIv") as string | null;
  const cekAuthTag = formData.get("cekAuthTag") as string | null;
  const cekWrapAadVersionStr = formData.get("cekWrapAadVersion") as string | null;

  if (!file || !iv || !authTag || !filename || !contentType || !sizeBytes) {
    return errorResponse(API_ERROR.MISSING_REQUIRED_FIELDS);
  }

  // Validate iv/authTag format (hex strings)
  if (!/^[0-9a-f]{24}$/.test(iv)) {
    return errorResponse(API_ERROR.INVALID_ENCRYPTION_FORMAT);
  }
  if (!/^[0-9a-f]{32}$/.test(authTag)) {
    return errorResponse(API_ERROR.INVALID_ENCRYPTION_FORMAT);
  }

  // Validate original file size (before encryption)
  const originalSize = parseInt(sizeBytes, 10);
  if (Number.isNaN(originalSize) || originalSize <= 0 || originalSize > MAX_FILE_SIZE) {
    return errorResponse(API_ERROR.FILE_TOO_LARGE);
  }

  // Validate extension
  const ext = getExtension(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext as typeof ALLOWED_EXTENSIONS[number])) {
    return errorResponse(API_ERROR.EXTENSION_NOT_ALLOWED);
  }

  // Validate content type
  if (!ALLOWED_CONTENT_TYPES.includes(contentType as typeof ALLOWED_CONTENT_TYPES[number])) {
    return errorResponse(API_ERROR.CONTENT_TYPE_NOT_ALLOWED);
  }

  // Validate filename (reject path traversal, CRLF, null bytes, Windows reserved names, etc.)
  if (!isValidSendFilename(filename)) {
    return errorResponse(API_ERROR.INVALID_FILENAME);
  }
  const sanitizedFilename = filename.slice(0, FILENAME_MAX_LENGTH);

  // Read encrypted blob and validate actual size
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) {
    return errorResponse(API_ERROR.FILE_TOO_LARGE);
  }

  const aadVersion = aadVersionStr ? parseInt(aadVersionStr, 10) : 1;
  if (Number.isNaN(aadVersion) || aadVersion !== 1) {
    return validationError();
  }

  // Every new team upload is mode 2 (plan C4): a random CEK encrypts the
  // body and is wrapped under the entry's ItemKey (scope "TW").
  if (!encryptionModeStr) {
    return errorResponse(API_ERROR.MISSING_REQUIRED_FIELDS);
  }
  if (parseInt(encryptionModeStr, 10) !== ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED) {
    return validationError();
  }
  if (!clientId || !itemKeyId || !cekKeyVersionStr || !cekEncrypted || !cekIv || !cekAuthTag || !cekWrapAadVersionStr) {
    return errorResponse(API_ERROR.MISSING_REQUIRED_FIELDS);
  }
  // The attachment id is bound into the body and CEK-wrap AAD, so the client
  // names it (UUID v4).
  if (!UUID_V4_RE.test(clientId) || !UUID_RE.test(itemKeyId)) {
    return validationError();
  }
  if (!/^[0-9a-f]{24}$/.test(cekIv) || !/^[0-9a-f]{32}$/.test(cekAuthTag)) {
    return validationError();
  }
  if (!/^[1-9][0-9]{0,8}$/.test(cekKeyVersionStr)) {
    return validationError();
  }
  const cekKeyVersion = parseInt(cekKeyVersionStr, 10);
  // Pinned to exactly the current format (see the personal upload route).
  const cekWrapAadVersion = parseInt(cekWrapAadVersionStr, 10);
  if (Number.isNaN(cekWrapAadVersion) || cekWrapAadVersion !== CURRENT_CEK_WRAP_AAD_VERSION) {
    return validationError();
  }
  if (cekEncrypted.length > CEK_WRAP_BASE64_MAX || !BASE64_RE.test(cekEncrypted)) {
    return validationError();
  }

  const blobStore = getAttachmentBlobStore();
  // Normalize to lowercase for AAD consistency.
  const attachmentId = clientId.toLowerCase();
  // A fresh object key per write, written before the transaction and deleted
  // if the transaction does not commit the row that references it.
  const blobContext = { attachmentId, entryId: id, teamId, generation: newBlobGeneration() };
  const storedBlob = await blobStore.putObject(buffer, blobContext);

  // Lock order: team FOR SHARE → entry FOR SHARE → per-entry advisory lock
  // (attachment cap). The entry's ItemKey identity is compared on the locked
  // row, so an upgrade, restore or re-key committed since the client read the
  // entry is refused rather than leaving a CEK wrapped under a key the entry
  // no longer holds. Over-limit and refusals return an outcome; the blob is
  // deleted outside the transaction.
  let outcome: UploadOutcome;
  try {
    outcome = await withTeamTenantRls(teamId, async (_tenantId, tx): Promise<UploadOutcome> => {
      let locked;
      try {
        locked = await lockTeamAttachmentEntry(tx, teamId, id);
      } catch (e) {
        if (e instanceof TeamRotationInProgressError) {
          return { ok: false, code: API_ERROR.TEAM_KEY_VERSION_MISMATCH };
        }
        throw e;
      }
      if (!locked) return { ok: false, code: API_ERROR.NOT_FOUND };
      // The actor's authority, under the team lock: a removal, departure or
      // demotion committed since requireTeamPermission is seen here.
      const role = await activeTeamRole(tx, teamId, session.user.id);
      if (!role || !canWriteTeamEntry(role, locked.createdById, session.user.id)) {
        return { ok: false, code: API_ERROR.ACTOR_NOT_PERMITTED };
      }

      // A v0 entry has no ItemKey to wrap under: the client upgrades it first.
      if (locked.itemKeyVersion === 0) {
        return { ok: false, code: API_ERROR.ENTRY_UPGRADE_REQUIRED };
      }
      if (!itemKeyIdsMatch(itemKeyId, locked.itemKeyId)) {
        return { ok: false, code: API_ERROR.ITEM_KEY_CHANGED };
      }
      if (cekKeyVersion !== locked.itemKeyVersion) {
        return { ok: false, code: API_ERROR.CEK_KEY_VERSION_MISMATCH };
      }
      // An ItemKey wrapped under an older team key (a restored retained row,
      // a carried entry) is re-keyed before a new CEK is wrapped under it, as
      // the full-update PUT refuses: a departed holder of that team key could
      // otherwise open the new attachment.
      if (normalizeTeamKeyVersion(locked.entryTeamKeyVersion) !== normalizeTeamKeyVersion(locked.teamKeyVersion)) {
        return { ok: false, code: API_ERROR.ENTRY_REKEY_REQUIRED };
      }

      // The per-entry cap, re-checked under a per-entry advisory lock so two
      // concurrent uploads cannot both read count < MAX and both create.
      await advisoryXactLock(tx, id);
      const count = await tx.attachment.count({
        where: { teamPasswordEntryId: id },
      });
      if (count >= MAX_ATTACHMENTS_PER_ENTRY) {
        return { ok: false, code: API_ERROR.ATTACHMENT_LIMIT_EXCEEDED };
      }

      const attachment = await tx.attachment.create({
        data: {
          id: attachmentId,
          filename: sanitizedFilename,
          contentType,
          sizeBytes: originalSize,
          encryptedData: Buffer.from(storedBlob),
          iv,
          authTag,
          aadVersion,
          keyVersion: locked.teamKeyVersion,
          encryptionMode: ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED,
          cekEncrypted: Buffer.from(cekEncrypted, "base64"),
          cekIv,
          cekAuthTag,
          cekKeyVersion,
          cekWrapAadVersion,
          // From the locked row, never from the client.
          cekItemKeyId: locked.itemKeyId,
          tenantId: locked.tenantId,
          teamPasswordEntryId: id,
          createdById: session.user.id,
        },
        select: {
          id: true,
          filename: true,
          contentType: true,
          sizeBytes: true,
          createdAt: true,
        },
      });
      return { ok: true, attachment };
    });
  } catch (error) {
    await blobStore.deleteObject(storedBlob, blobContext).catch(() => {});
    throw error;
  }

  if (!outcome.ok) {
    await blobStore.deleteObject(storedBlob, blobContext).catch(() => {});
    return outcome.code === API_ERROR.NOT_FOUND ? notFound() : errorResponse(outcome.code);
  }
  const { attachment } = outcome;

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.ATTACHMENT_UPLOAD,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachment.id,
    metadata: { filename: sanitizedFilename, sizeBytes: originalSize, entryId: id },
  });

  return NextResponse.json(attachment, { status: 201 });
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
