import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";

type RouteContext = {
  params: Promise<{ id: string; attachmentId: string }>;
};

// GET /api/passwords/[id]/attachments/[attachmentId] - Download encrypted attachment
async function handleGET(
  _req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id, attachmentId } = await params;

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: { userId: true },
    }),
  );

  if (!entry) {
    return notFound();
  }
  if (entry.userId !== session.user.id) {
    // A01-4: 403 vs 404 difference leaks "ID exists in tenant" oracle to
    // attacker. RLS should already null this branch; defense-in-depth.
    return notFound();
  }

  const attachment = await withUserTenantRls(session.user.id, async () =>
    prisma.attachment.findUnique({
      where: { id: attachmentId, passwordEntryId: id },
    }),
  );

  if (!attachment) {
    return errorResponse(API_ERROR.ATTACHMENT_NOT_FOUND);
  }

  const blobStore = getAttachmentBlobStore();
  const encryptedBuffer = await blobStore.getObject(attachment.encryptedData, {
    attachmentId,
    entryId: id,
  });
  const isMode2 = attachment.encryptionMode === 2;
  // Return encrypted data + crypto metadata for client-side decryption
  return NextResponse.json({
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    encryptedData: encryptedBuffer.toString("base64"),
    iv: attachment.iv,
    authTag: attachment.authTag,
    keyVersion: attachment.keyVersion,
    aadVersion: attachment.aadVersion,
    encryptionMode: attachment.encryptionMode,
    cekEncrypted: isMode2 && attachment.cekEncrypted
      ? Buffer.from(attachment.cekEncrypted).toString("base64")
      : null,
    cekIv: isMode2 ? attachment.cekIv : null,
    cekAuthTag: isMode2 ? attachment.cekAuthTag : null,
    cekKeyVersion: isMode2 ? attachment.cekKeyVersion : null,
    cekWrapAadVersion: isMode2 ? attachment.cekWrapAadVersion : null,
  });
}

// DELETE /api/passwords/[id]/attachments/[attachmentId] - Delete attachment
async function handleDELETE(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id, attachmentId } = await params;

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: { userId: true },
    }),
  );

  if (!entry) {
    return notFound();
  }
  if (entry.userId !== session.user.id) {
    // A01-4: 403 vs 404 difference leaks "ID exists in tenant" oracle to
    // attacker. RLS should already null this branch; defense-in-depth.
    return notFound();
  }

  const attachment = await withUserTenantRls(session.user.id, async () =>
    prisma.attachment.findUnique({
      where: { id: attachmentId, passwordEntryId: id },
      select: { id: true, filename: true, encryptedData: true },
    }),
  );

  if (!attachment) {
    return errorResponse(API_ERROR.ATTACHMENT_NOT_FOUND);
  }

  const blobStore = getAttachmentBlobStore();
  await blobStore.deleteObject(attachment.encryptedData, {
    attachmentId,
    entryId: id,
  });

  await withUserTenantRls(session.user.id, async () =>
    prisma.attachment.delete({
      where: { id: attachmentId, passwordEntryId: id },
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.ATTACHMENT_DELETE,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachmentId,
    metadata: { filename: attachment.filename, entryId: id },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
