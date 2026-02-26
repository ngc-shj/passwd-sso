import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { AUDIT_TARGET_TYPE, TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

type RouteContext = {
  params: Promise<{ teamId: string; id: string; attachmentId: string }>;
};

// GET /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId] - Download encrypted attachment
export async function GET(
  _req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id, attachmentId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.teamPasswordEntry.findUnique({
    where: { id },
    select: { teamId: true },
  });

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId, teamPasswordEntryId: id },
  });

  if (!attachment) {
    return NextResponse.json({ error: API_ERROR.ATTACHMENT_NOT_FOUND }, { status: 404 });
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
  });
}

// DELETE /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId] - Delete attachment
export async function DELETE(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id, attachmentId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.teamPasswordEntry.findUnique({
    where: { id },
    select: { teamId: true },
  });

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId, teamPasswordEntryId: id },
    select: { id: true, filename: true, encryptedData: true },
  });

  if (!attachment) {
    return NextResponse.json({ error: API_ERROR.ATTACHMENT_NOT_FOUND }, { status: 404 });
  }

  const blobStore = getAttachmentBlobStore();
  await blobStore.deleteObject(attachment.encryptedData, {
    attachmentId,
    entryId: id,
    teamId,
  });

  await prisma.attachment.delete({
    where: { id: attachmentId },
  });

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ATTACHMENT_DELETE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachmentId,
    metadata: { filename: attachment.filename, entryId: id },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
