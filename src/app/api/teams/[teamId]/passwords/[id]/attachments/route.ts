import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { requireTeamPermission } from "@/lib/auth/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { AUDIT_TARGET_TYPE, TEAM_PERMISSION, AUDIT_ACTION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
  FILENAME_MAX_LENGTH,
  isValidSendFilename,
} from "@/lib/validations";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, notFound, rateLimited, unauthorized } from "@/lib/api-response";
import { createRateLimiter } from "@/lib/rate-limit";

type RouteContext = { params: Promise<{ teamId: string; id: string }> };

const teamAttachmentUploadLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

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

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const rl = await teamAttachmentUploadLimiter.check(`rl:team_attachment_upload:${session.user.id}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true, tenantId: true, itemKeyVersion: true, teamKeyVersion: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  // Require ItemKey (itemKeyVersion >= 1) for attachment upload
  if ((entry.itemKeyVersion ?? 0) < 1) {
    return errorResponse(API_ERROR.ITEM_KEY_REQUIRED, 400);
  }

  // Check attachment count limit
  const count = await withTeamTenantRls(teamId, async () =>
    prisma.attachment.count({
      where: { teamPasswordEntryId: id },
    }),
  );
  if (count >= MAX_ATTACHMENTS_PER_ENTRY) {
    return errorResponse(API_ERROR.ATTACHMENT_LIMIT_EXCEEDED, 400);
  }

  // Early rejection: check Content-Length before consuming body into memory
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const declaredSize = parseInt(contentLength, 10);
    if (!Number.isNaN(declaredSize) && declaredSize > MAX_FILE_SIZE * 2) {
      return errorResponse(API_ERROR.PAYLOAD_TOO_LARGE, 413);
    }
  }

  // Parse FormData
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse(API_ERROR.INVALID_FORM_DATA, 400);
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

  if (!file || !iv || !authTag || !filename || !contentType || !sizeBytes) {
    return errorResponse(API_ERROR.MISSING_REQUIRED_FIELDS, 400);
  }

  // Validate iv/authTag format (hex strings)
  if (!/^[0-9a-f]{24}$/.test(iv)) {
    return errorResponse(API_ERROR.INVALID_IV_FORMAT, 400);
  }
  if (!/^[0-9a-f]{32}$/.test(authTag)) {
    return errorResponse(API_ERROR.INVALID_AUTH_TAG_FORMAT, 400);
  }

  // Validate original file size (before encryption)
  const originalSize = parseInt(sizeBytes, 10);
  if (Number.isNaN(originalSize) || originalSize <= 0 || originalSize > MAX_FILE_SIZE) {
    return errorResponse(API_ERROR.FILE_TOO_LARGE, 400);
  }

  // Validate extension
  const ext = getExtension(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext as typeof ALLOWED_EXTENSIONS[number])) {
    return errorResponse(API_ERROR.EXTENSION_NOT_ALLOWED, 400);
  }

  // Validate content type
  if (!ALLOWED_CONTENT_TYPES.includes(contentType as typeof ALLOWED_CONTENT_TYPES[number])) {
    return errorResponse(API_ERROR.CONTENT_TYPE_NOT_ALLOWED, 400);
  }

  // Validate filename (reject path traversal, CRLF, null bytes, Windows reserved names, etc.)
  if (!isValidSendFilename(filename)) {
    return errorResponse(API_ERROR.INVALID_FILENAME, 400);
  }
  const sanitizedFilename = filename.slice(0, FILENAME_MAX_LENGTH);

  // Read encrypted blob and validate actual size
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) {
    return errorResponse(API_ERROR.FILE_TOO_LARGE, 400);
  }

  const aadVersion = aadVersionStr ? parseInt(aadVersionStr, 10) : 1;
  if (Number.isNaN(aadVersion) || aadVersion < 1 || aadVersion > 1) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // encryptionMode is required and must be 1 (ItemKey)
  if (!encryptionModeStr) {
    return errorResponse(API_ERROR.MISSING_REQUIRED_FIELDS, 400);
  }
  const encryptionMode = parseInt(encryptionModeStr, 10);
  if (encryptionMode !== 1) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate aadVersion (must be 1)
  if (aadVersion !== 1) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate client-provided attachmentId format (UUID v4)
  if (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  const blobStore = getAttachmentBlobStore();
  // clientId already validated as UUID v4 above (line 209); normalize to lowercase for AAD consistency
  const attachmentId = clientId ? clientId.toLowerCase() : crypto.randomUUID();
  const blobContext = { attachmentId, entryId: id, teamId };
  const storedBlob = await blobStore.putObject(buffer, blobContext);

  let attachment;
  try {
    attachment = await withTeamTenantRls(teamId, async () =>
      prisma.attachment.create({
        data: {
          id: attachmentId,
          filename: sanitizedFilename,
          contentType,
          sizeBytes: originalSize,
          encryptedData: Buffer.from(storedBlob),
          iv,
          authTag,
          aadVersion,
          keyVersion: entry.teamKeyVersion,
          encryptionMode,
          tenantId: entry.tenantId,
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
      }),
    );
  } catch (error) {
    await blobStore.deleteObject(storedBlob, blobContext).catch(() => {});
    throw error;
  }

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
