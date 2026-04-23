import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { requireTeamPermission } from "@/lib/auth/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { AUDIT_TARGET_TYPE, TEAM_PERMISSION, AUDIT_ACTION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/api-response";

type RouteContext = {
  params: Promise<{ teamId: string; id: string; attachmentId: string }>;
};

// GET /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId] - Download encrypted attachment
async function handleGET(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, attachmentId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const attachment = await withTeamTenantRls(teamId, async () =>
    prisma.attachment.findUnique({
      where: { id: attachmentId, teamPasswordEntryId: id },
    }),
  );

  if (!attachment) {
    return errorResponse(API_ERROR.ATTACHMENT_NOT_FOUND, 404);
  }

  // Return encrypted data + crypto metadata for client-side decryption
  const blobStore = getAttachmentBlobStore();
  const encryptedBuffer = await blobStore.getObject(attachment.encryptedData, {
    attachmentId,
    entryId: id,
    teamId,
  });

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
  });
}

// DELETE /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId] - Delete attachment
async function handleDELETE(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, attachmentId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const attachment = await withTeamTenantRls(teamId, async () =>
    prisma.attachment.findUnique({
      where: { id: attachmentId, teamPasswordEntryId: id },
      select: { id: true, filename: true, encryptedData: true },
    }),
  );

  if (!attachment) {
    return errorResponse(API_ERROR.ATTACHMENT_NOT_FOUND, 404);
  }

  const blobStore = getAttachmentBlobStore();
  await blobStore.deleteObject(attachment.encryptedData, {
    attachmentId,
    entryId: id,
    teamId,
  });

  await withTeamTenantRls(teamId, async () =>
    prisma.attachment.delete({
      where: { id: attachmentId },
    }),
  );

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.ATTACHMENT_DELETE,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachmentId,
    metadata: { filename: attachment.filename, entryId: id },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
