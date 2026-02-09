import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateOrgPasswordSchema, updateOrgSecureNoteSchema } from "@/lib/validations";
import {
  requireOrgPermission,
  requireOrgMember,
  hasOrgPermission,
  OrgAuthError,
} from "@/lib/org-auth";
import {
  unwrapOrgKey,
  encryptServerData,
  decryptServerData,
} from "@/lib/crypto-server";

type Params = { params: Promise<{ orgId: string; id: string }> };

function getOrgKey(org: {
  encryptedOrgKey: string;
  orgKeyIv: string;
  orgKeyAuthTag: string;
}) {
  return unwrapOrgKey({
    ciphertext: org.encryptedOrgKey,
    iv: org.orgKeyIv,
    authTag: org.orgKeyAuthTag,
  });
}

// GET /api/orgs/[orgId]/passwords/[id] — Get password detail (server decrypts)
export async function GET(_req: NextRequest, { params }: Params) {
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
    include: {
      org: {
        select: {
          encryptedOrgKey: true,
          orgKeyIv: true,
          orgKeyAuthTag: true,
        },
      },
      tags: { select: { id: true, name: true, color: true } },
      createdBy: { select: { id: true, name: true, image: true } },
      updatedBy: { select: { id: true, name: true } },
      favorites: {
        where: { userId: session.user.id },
        select: { id: true },
      },
    },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const orgKey = getOrgKey(entry.org);
  const blob = JSON.parse(
    decryptServerData(
      {
        ciphertext: entry.encryptedBlob,
        iv: entry.blobIv,
        authTag: entry.blobAuthTag,
      },
      orgKey
    )
  );

  const common = {
    id: entry.id,
    entryType: entry.entryType,
    title: blob.title,
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    tags: entry.tags,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };

  if (entry.entryType === "SECURE_NOTE") {
    return NextResponse.json({
      ...common,
      content: blob.content,
    });
  }

  return NextResponse.json({
    ...common,
    username: blob.username,
    password: blob.password,
    url: blob.url,
    notes: blob.notes,
    customFields: blob.customFields ?? [],
    totp: blob.totp ?? null,
  });
}

// PUT /api/orgs/[orgId]/passwords/[id] — Update password
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id } = await params;

  let membership;
  try {
    membership = await requireOrgMember(session.user.id, orgId);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    include: {
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

  // MEMBER can only update their own entries
  if (!hasOrgPermission(membership.role, "password:update")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (
    membership.role === "MEMBER" &&
    entry.createdById !== session.user.id
  ) {
    return NextResponse.json(
      { error: "Can only update your own entries" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const orgKey = getOrgKey(entry.org);

  // Decrypt current blob and merge updates
  const currentBlob = JSON.parse(
    decryptServerData(
      {
        ciphertext: entry.encryptedBlob,
        iv: entry.blobIv,
        authTag: entry.blobAuthTag,
      },
      orgKey
    )
  );

  let updatedBlobStr: string;
  let overviewBlobStr: string;
  let tagIds: string[] | undefined;
  let isArchived: boolean | undefined;
  let responseTitle: string;

  if (entry.entryType === "SECURE_NOTE") {
    const parsed = updateOrgSecureNoteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    tagIds = parsed.data.tagIds;
    isArchived = parsed.data.isArchived;

    const updatedBlob = {
      title: parsed.data.title ?? currentBlob.title,
      content: parsed.data.content ?? currentBlob.content,
    };
    responseTitle = updatedBlob.title;

    const snippet = updatedBlob.content.slice(0, 100);
    updatedBlobStr = JSON.stringify(updatedBlob);
    overviewBlobStr = JSON.stringify({ title: updatedBlob.title, snippet });
  } else {
    const parsed = updateOrgPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { customFields, totp, ...fieldUpdates } = parsed.data;
    tagIds = parsed.data.tagIds;
    isArchived = parsed.data.isArchived;

    const updatedBlob: Record<string, unknown> = {
      title: fieldUpdates.title ?? currentBlob.title,
      username:
        fieldUpdates.username !== undefined
          ? fieldUpdates.username || null
          : currentBlob.username,
      password: fieldUpdates.password ?? currentBlob.password,
      url:
        fieldUpdates.url !== undefined
          ? fieldUpdates.url || null
          : currentBlob.url,
      notes:
        fieldUpdates.notes !== undefined
          ? fieldUpdates.notes || null
          : currentBlob.notes,
    };

    if (customFields !== undefined) {
      updatedBlob.customFields = customFields?.length ? customFields : undefined;
    } else if (currentBlob.customFields) {
      updatedBlob.customFields = currentBlob.customFields;
    }

    if (totp !== undefined) {
      updatedBlob.totp = totp ?? undefined;
    } else if (currentBlob.totp) {
      updatedBlob.totp = currentBlob.totp;
    }

    responseTitle = updatedBlob.title as string;

    let urlHost: string | null = null;
    if (updatedBlob.url) {
      try {
        urlHost = new URL(updatedBlob.url as string).hostname;
      } catch {
        /* invalid url */
      }
    }

    updatedBlobStr = JSON.stringify(updatedBlob);
    overviewBlobStr = JSON.stringify({
      title: updatedBlob.title,
      username: updatedBlob.username,
      urlHost,
    });
  }

  const encryptedBlob = encryptServerData(updatedBlobStr, orgKey);
  const encryptedOverview = encryptServerData(overviewBlobStr, orgKey);

  const updateData: Record<string, unknown> = {
    encryptedBlob: encryptedBlob.ciphertext,
    blobIv: encryptedBlob.iv,
    blobAuthTag: encryptedBlob.authTag,
    encryptedOverview: encryptedOverview.ciphertext,
    overviewIv: encryptedOverview.iv,
    overviewAuthTag: encryptedOverview.authTag,
    updatedById: session.user.id,
  };

  if (isArchived !== undefined) updateData.isArchived = isArchived;
  if (tagIds !== undefined) {
    updateData.tags = { set: tagIds.map((tid) => ({ id: tid })) };
  }

  const updated = await prisma.orgPasswordEntry.update({
    where: { id },
    data: updateData,
    include: {
      tags: { select: { id: true, name: true, color: true } },
    },
  });

  return NextResponse.json({
    id: updated.id,
    entryType: updated.entryType,
    title: responseTitle,
    tags: updated.tags,
    updatedAt: updated.updatedAt,
  });
}

// DELETE /api/orgs/[orgId]/passwords/[id] — Soft delete (move to trash)
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "password:delete");
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await prisma.orgPasswordEntry.findUnique({
    where: { id },
  });

  if (!existing || existing.orgId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  if (permanent) {
    await prisma.orgPasswordEntry.delete({ where: { id } });
  } else {
    await prisma.orgPasswordEntry.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  return NextResponse.json({ success: true });
}
