import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { unwrapOrgKey, encryptServerBinary } from "@/lib/crypto-server";
import { buildAttachmentAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { AUDIT_TARGET_TYPE, ORG_PERMISSION } from "@/lib/constants";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
} from "@/lib/validations";

type RouteContext = { params: Promise<{ orgId: string; id: string }> };

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

// GET /api/orgs/[orgId]/passwords/[id]/attachments - List attachment metadata
export async function GET(
  _req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    select: { orgId: true },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const attachments = await prisma.attachment.findMany({
    where: { orgPasswordEntryId: id },
    select: {
      id: true,
      filename: true,
      contentType: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(attachments);
}

// POST /api/orgs/[orgId]/passwords/[id]/attachments - Upload attachment (server-side encrypted)
export async function POST(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.PASSWORD_UPDATE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    select: {
      orgId: true,
      org: {
        select: {
          encryptedOrgKey: true,
          orgKeyIv: true,
          orgKeyAuthTag: true,
        },
      },
    },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Check attachment count limit
  const count = await prisma.attachment.count({
    where: { orgPasswordEntryId: id },
  });
  if (count >= MAX_ATTACHMENTS_PER_ENTRY) {
    return NextResponse.json(
      { error: API_ERROR.ATTACHMENT_LIMIT_EXCEEDED },
      { status: 400 }
    );
  }

  // Early rejection: check Content-Length before consuming body into memory
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const declaredSize = parseInt(contentLength, 10);
    if (!isNaN(declaredSize) && declaredSize > MAX_FILE_SIZE * 2) {
      return NextResponse.json(
        { error: API_ERROR.PAYLOAD_TOO_LARGE },
        { status: 413 }
      );
    }
  }

  // Parse FormData
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_FORM_DATA }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const filename = formData.get("filename") as string | null;
  const contentType = formData.get("contentType") as string | null;

  if (!file || !filename || !contentType) {
    return NextResponse.json(
      { error: API_ERROR.MISSING_REQUIRED_FIELDS },
      { status: 400 }
    );
  }

  // Validate size (File.size from Web API reflects actual parsed blob size)
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: API_ERROR.FILE_TOO_LARGE },
      { status: 400 }
    );
  }

  // Validate extension
  const ext = getExtension(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext as typeof ALLOWED_EXTENSIONS[number])) {
    return NextResponse.json(
      { error: API_ERROR.EXTENSION_NOT_ALLOWED },
      { status: 400 }
    );
  }

  // Validate content type
  if (!ALLOWED_CONTENT_TYPES.includes(contentType as typeof ALLOWED_CONTENT_TYPES[number])) {
    return NextResponse.json(
      { error: API_ERROR.CONTENT_TYPE_NOT_ALLOWED },
      { status: 400 }
    );
  }

  // Sanitize filename
  const sanitizedFilename = filename.replace(/[/\\]/g, "_").slice(0, 255);

  // Read plaintext file and validate actual buffer size (defense in depth)
  const plainBuffer = Buffer.from(await file.arrayBuffer());
  if (plainBuffer.length > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: API_ERROR.FILE_TOO_LARGE },
      { status: 400 }
    );
  }

  // Encrypt server-side
  const orgKey = unwrapOrgKey({
    ciphertext: entry.org.encryptedOrgKey,
    iv: entry.org.orgKeyIv,
    authTag: entry.org.orgKeyAuthTag,
  });
  // Pre-generate attachment ID for AAD binding
  const attachmentId = crypto.randomUUID();
  const aad = Buffer.from(buildAttachmentAAD(id, attachmentId));
  const encrypted = encryptServerBinary(plainBuffer, orgKey, aad);
  const blobStore = getAttachmentBlobStore();
  const blobContext = { attachmentId, entryId: id, orgId };
  const storedBlob = await blobStore.putObject(encrypted.ciphertext, blobContext);

  let attachment;
  try {
    attachment = await prisma.attachment.create({
      data: {
        id: attachmentId,
        filename: sanitizedFilename,
        contentType,
        sizeBytes: file.size,
        encryptedData: Buffer.from(storedBlob),
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        aadVersion: AAD_VERSION,
        orgPasswordEntryId: id,
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
  } catch (error) {
    await blobStore.deleteObject(storedBlob, blobContext).catch(() => {});
    throw error;
  }

  logAudit({
    scope: "ORG",
    action: "ATTACHMENT_UPLOAD",
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachment.id,
    metadata: { filename: sanitizedFilename, sizeBytes: file.size, entryId: id },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(attachment, { status: 201 });
}
