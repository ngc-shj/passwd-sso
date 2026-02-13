import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";

type RouteContext = {
  params: Promise<{ id: string; attachmentId: string }>;
};

// GET /api/passwords/[id]/attachments/[attachmentId] - Download encrypted attachment
export async function GET(
  _req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id, attachmentId } = await params;

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

  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId, passwordEntryId: id },
  });

  if (!attachment) {
    return NextResponse.json({ error: API_ERROR.ATTACHMENT_NOT_FOUND }, { status: 404 });
  }

  const blobStore = getAttachmentBlobStore();
  // Return encrypted data + crypto metadata for client-side decryption
  return NextResponse.json({
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    encryptedData: blobStore.toBase64(attachment.encryptedData),
    iv: attachment.iv,
    authTag: attachment.authTag,
    keyVersion: attachment.keyVersion,
    aadVersion: attachment.aadVersion,
  });
}

// DELETE /api/passwords/[id]/attachments/[attachmentId] - Delete attachment
export async function DELETE(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id, attachmentId } = await params;

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

  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId, passwordEntryId: id },
    select: { id: true, filename: true },
  });

  if (!attachment) {
    return NextResponse.json({ error: API_ERROR.ATTACHMENT_NOT_FOUND }, { status: 404 });
  }

  await prisma.attachment.delete({
    where: { id: attachmentId },
  });

  logAudit({
    scope: "PERSONAL",
    action: "ATTACHMENT_DELETE",
    userId: session.user.id,
    targetType: "Attachment",
    targetId: attachmentId,
    metadata: { filename: attachment.filename, entryId: id },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
