import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
  FILENAME_MAX_LENGTH,
  isValidSendFilename,
} from "@/lib/validations";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { AAD_VERSION } from "@/lib/crypto/crypto-aad";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, forbidden, notFound, unauthorized, rateLimited } from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";

type RouteContext = { params: Promise<{ id: string }> };

const attachmentUploadLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

// GET /api/passwords/[id]/attachments - List attachment metadata
async function handleGET(
  _req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: { userId: true, tenantId: true },
    }),
  );

  if (!entry) {
    return notFound();
  }
  if (entry.userId !== session.user.id) {
    return forbidden();
  }

  const attachments = await withUserTenantRls(session.user.id, async () =>
    prisma.attachment.findMany({
      where: { passwordEntryId: id },
      select: {
        id: true,
        filename: true,
        contentType: true,
        sizeBytes: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json(attachments);
}

// POST /api/passwords/[id]/attachments - Upload encrypted attachment
async function handlePOST(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: { userId: true, tenantId: true },
    }),
  );

  if (!entry) {
    return notFound();
  }
  if (entry.userId !== session.user.id) {
    return forbidden();
  }

  const rl = await attachmentUploadLimiter.check(`rl:attachment_upload:${session.user.id}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  // Check attachment count limit
  const count = await withUserTenantRls(session.user.id, async () =>
    prisma.attachment.count({
      where: { passwordEntryId: id },
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
  const keyVersion = formData.get("keyVersion") as string | null;
  const aadVersionStr = formData.get("aadVersion") as string | null;

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

  const blobStore = getAttachmentBlobStore();
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const attachmentId = (clientId && UUID_V4_RE.test(clientId)) ? clientId.toLowerCase() : crypto.randomUUID();
  const blobContext = { attachmentId, entryId: id };
  const storedBlob = await blobStore.putObject(buffer, blobContext);
  const aadVersion = aadVersionStr ? parseInt(aadVersionStr, 10) : AAD_VERSION;
  if (Number.isNaN(aadVersion) || aadVersion < 1 || aadVersion > 1) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  let attachment;
  try {
    attachment = await withUserTenantRls(session.user.id, async () =>
      prisma.attachment.create({
        data: {
          id: attachmentId,
          filename: sanitizedFilename,
          contentType,
          sizeBytes: originalSize,
          encryptedData: Buffer.from(storedBlob),
          iv,
          authTag,
          keyVersion: keyVersion ? parseInt(keyVersion, 10) : null,
          aadVersion,
          tenantId: entry.tenantId,
          passwordEntryId: id,
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
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.ATTACHMENT_UPLOAD,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachment.id,
    metadata: { filename: sanitizedFilename, sizeBytes: originalSize, entryId: id },
  });

  return NextResponse.json(attachment, { status: 201 });
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
