import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { unwrapOrgKey, encryptServerBinary } from "@/lib/crypto-server";
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id } = await params;

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
    select: { orgId: true },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "password:update");
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

  // Check attachment count limit
  const count = await prisma.attachment.count({
    where: { orgPasswordEntryId: id },
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
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const filename = formData.get("filename") as string | null;
  const contentType = formData.get("contentType") as string | null;

  if (!file || !filename || !contentType) {
    return NextResponse.json(
      { error: "Missing required fields: file, filename, contentType" },
      { status: 400 }
    );
  }

  // Validate size
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File size must not exceed ${MAX_FILE_SIZE / 1024 / 1024}MB` },
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

  // Sanitize filename
  const sanitizedFilename = filename.replace(/[/\\]/g, "_").slice(0, 255);

  // Read plaintext file and encrypt server-side
  const plainBuffer = Buffer.from(await file.arrayBuffer());
  const orgKey = unwrapOrgKey({
    ciphertext: entry.org.encryptedOrgKey,
    iv: entry.org.orgKeyIv,
    authTag: entry.org.orgKeyAuthTag,
  });
  const encrypted = encryptServerBinary(plainBuffer, orgKey);

  const attachment = await prisma.attachment.create({
    data: {
      filename: sanitizedFilename,
      contentType,
      sizeBytes: file.size,
      encryptedData: new Uint8Array(encrypted.ciphertext),
      iv: encrypted.iv,
      authTag: encrypted.authTag,
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

  logAudit({
    scope: "ORG",
    action: "ATTACHMENT_UPLOAD",
    userId: session.user.id,
    orgId,
    targetType: "Attachment",
    targetId: attachment.id,
    metadata: { filename: sanitizedFilename, sizeBytes: file.size, entryId: id },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(attachment, { status: 201 });
}
