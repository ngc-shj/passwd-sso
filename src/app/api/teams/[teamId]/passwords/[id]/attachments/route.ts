import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { AUDIT_TARGET_TYPE, TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
  isValidSendFilename,
} from "@/lib/validations";

type RouteContext = { params: Promise<{ teamId: string; id: string }> };

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

// GET /api/teams/[teamId]/passwords/[id]/attachments - List attachment metadata
export async function GET(
  _req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    select: { orgId: true },
  });

  if (!entry || entry.orgId !== teamId) {
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

// POST /api/teams/[teamId]/passwords/[id]/attachments - Upload attachment (client-side encrypted)
export async function POST(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    select: { orgId: true },
  });

  if (!entry || entry.orgId !== teamId) {
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

  const clientId = formData.get("id") as string | null;
  const file = formData.get("file") as File | null;
  const iv = formData.get("iv") as string | null;
  const authTag = formData.get("authTag") as string | null;
  const filename = formData.get("filename") as string | null;
  const contentType = formData.get("contentType") as string | null;
  const sizeBytes = formData.get("sizeBytes") as string | null;
  const orgKeyVersionStr = formData.get("orgKeyVersion") as string | null;
  const aadVersionStr = formData.get("aadVersion") as string | null;

  if (!file || !iv || !authTag || !filename || !contentType || !sizeBytes) {
    return NextResponse.json(
      { error: API_ERROR.MISSING_REQUIRED_FIELDS },
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

  // Validate filename (reject path traversal, CRLF, null bytes, Windows reserved names, etc.)
  if (!isValidSendFilename(filename)) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_FILENAME },
      { status: 400 }
    );
  }
  const sanitizedFilename = filename.slice(0, 255);

  // Read encrypted blob and validate actual size
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: API_ERROR.FILE_TOO_LARGE },
      { status: 400 }
    );
  }

  const aadVersion = aadVersionStr ? parseInt(aadVersionStr, 10) : 1;
  const orgKeyVersion = orgKeyVersionStr ? parseInt(orgKeyVersionStr, 10) : 1;

  // Validate orgKeyVersion matches current org key version (S-20/F-23)
  const team = await prisma.organization.findUnique({
    where: { id: teamId },
    select: { orgKeyVersion: true },
  });
  if (!team || orgKeyVersion !== team.orgKeyVersion) {
    return NextResponse.json(
      { error: API_ERROR.ORG_KEY_VERSION_MISMATCH },
      { status: 409 }
    );
  }

  const blobStore = getAttachmentBlobStore();
  const attachmentId = clientId ?? crypto.randomUUID();
  const blobContext = { attachmentId, entryId: id, orgId: teamId };
  const storedBlob = await blobStore.putObject(buffer, blobContext);

  let attachment;
  try {
    attachment = await prisma.attachment.create({
      data: {
        id: attachmentId,
        filename: sanitizedFilename,
        contentType,
        sizeBytes: originalSize,
        encryptedData: Buffer.from(storedBlob),
        iv,
        authTag,
        aadVersion,
        keyVersion: orgKeyVersion,
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
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.ATTACHMENT_UPLOAD,
    userId: session.user.id,
    orgId: teamId,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachment.id,
    metadata: { filename: sanitizedFilename, sizeBytes: originalSize, entryId: id },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(attachment, { status: 201 });
}
