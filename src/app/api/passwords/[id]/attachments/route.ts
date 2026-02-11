import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
} from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";

type RouteContext = { params: Promise<{ id: string }> };

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

// GET /api/passwords/[id]/attachments - List attachment metadata
export async function GET(
  _req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const entry = await prisma.passwordEntry.findUnique({
    where: { id },
    select: { userId: true },
  });

  if (!entry) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (entry.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  const attachments = await prisma.attachment.findMany({
    where: { passwordEntryId: id },
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

// POST /api/passwords/[id]/attachments - Upload encrypted attachment
export async function POST(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const entry = await prisma.passwordEntry.findUnique({
    where: { id },
    select: { userId: true },
  });

  if (!entry) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (entry.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  // Check attachment count limit
  const count = await prisma.attachment.count({
    where: { passwordEntryId: id },
  });
  if (count >= MAX_ATTACHMENTS_PER_ENTRY) {
    return NextResponse.json(
      { error: `Maximum ${MAX_ATTACHMENTS_PER_ENTRY} attachments per entry` },
      { status: 400 }
    );
  }

  // Parse FormData
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_FORM_DATA }, { status: 400 });
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
    return NextResponse.json(
      { error: "Missing required fields: file, iv, authTag, filename, contentType, sizeBytes" },
      { status: 400 }
    );
  }

  // Validate iv/authTag format (hex strings)
  if (!/^[0-9a-f]{24}$/.test(iv)) {
    return NextResponse.json({ error: API_ERROR.INVALID_IV_FORMAT }, { status: 400 });
  }
  if (!/^[0-9a-f]{32}$/.test(authTag)) {
    return NextResponse.json({ error: API_ERROR.INVALID_AUTH_TAG_FORMAT }, { status: 400 });
  }

  // Validate original file size (before encryption)
  const originalSize = parseInt(sizeBytes, 10);
  if (isNaN(originalSize) || originalSize <= 0 || originalSize > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File size must be between 1 byte and ${MAX_FILE_SIZE / 1024 / 1024}MB` },
      { status: 400 }
    );
  }

  // Validate extension
  const ext = getExtension(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext as typeof ALLOWED_EXTENSIONS[number])) {
    return NextResponse.json(
      { error: `File extension not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}` },
      { status: 400 }
    );
  }

  // Validate content type
  if (!ALLOWED_CONTENT_TYPES.includes(contentType as typeof ALLOWED_CONTENT_TYPES[number])) {
    return NextResponse.json(
      { error: `Content type not allowed. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  // Sanitize filename (prevent path traversal)
  const sanitizedFilename = filename.replace(/[/\\]/g, "_").slice(0, 255);

  // Read encrypted blob and validate actual size
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `Uploaded file exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB` },
      { status: 400 }
    );
  }

  const aadVersion = aadVersionStr ? parseInt(aadVersionStr, 10) : 0;
  const attachment = await prisma.attachment.create({
    data: {
      ...(clientId ? { id: clientId } : {}),
      filename: sanitizedFilename,
      contentType,
      sizeBytes: originalSize,
      encryptedData: buffer,
      iv,
      authTag,
      keyVersion: keyVersion ? parseInt(keyVersion, 10) : null,
      aadVersion,
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
  });

  logAudit({
    scope: "PERSONAL",
    action: "ATTACHMENT_UPLOAD",
    userId: session.user.id,
    targetType: "Attachment",
    targetId: attachment.id,
    metadata: { filename: sanitizedFilename, sizeBytes: originalSize, entryId: id },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(attachment, { status: 201 });
}
