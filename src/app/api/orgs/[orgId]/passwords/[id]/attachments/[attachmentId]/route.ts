import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { unwrapOrgKey, decryptServerBinary } from "@/lib/crypto-server";

type RouteContext = {
  params: Promise<{ orgId: string; id: string; attachmentId: string }>;
};

// GET /api/orgs/[orgId]/passwords/[id]/attachments/[attachmentId] - Download attachment (decrypted)
export async function GET(
  _req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id, attachmentId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "password:read");
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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId, orgPasswordEntryId: id },
  });

  if (!attachment) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  // Decrypt server-side and return plaintext binary
  const orgKey = unwrapOrgKey({
    ciphertext: entry.org.encryptedOrgKey,
    iv: entry.org.orgKeyIv,
    authTag: entry.org.orgKeyAuthTag,
  });

  const decrypted = decryptServerBinary(
    {
      ciphertext: Buffer.from(attachment.encryptedData),
      iv: attachment.iv,
      authTag: attachment.authTag,
    },
    orgKey
  );

  return new NextResponse(new Uint8Array(decrypted), {
    headers: {
      "Content-Type": attachment.contentType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(attachment.filename)}"`,
      "Content-Length": attachment.sizeBytes.toString(),
    },
  });
}

// DELETE /api/orgs/[orgId]/passwords/[id]/attachments/[attachmentId] - Delete attachment
export async function DELETE(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id, attachmentId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "password:delete");
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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId, orgPasswordEntryId: id },
    select: { id: true, filename: true },
  });

  if (!attachment) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  await prisma.attachment.delete({
    where: { id: attachmentId },
  });

  logAudit({
    scope: "ORG",
    action: "ATTACHMENT_DELETE",
    userId: session.user.id,
    orgId,
    targetType: "Attachment",
    targetId: attachmentId,
    metadata: { filename: attachment.filename, entryId: id },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
