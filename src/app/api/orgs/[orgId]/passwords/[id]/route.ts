import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateOrgPasswordSchema, updateOrgSecureNoteSchema, updateOrgCreditCardSchema, updateOrgIdentitySchema } from "@/lib/validations";
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
import { buildOrgEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";

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
  const blobAad = entry.aadVersion >= 1
    ? Buffer.from(buildOrgEntryAAD(orgId, entry.id, "blob"))
    : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let blob: Record<string, any>;
  try {
    blob = JSON.parse(
      decryptServerData(
        {
          ciphertext: entry.encryptedBlob,
          iv: entry.blobIv,
          authTag: entry.blobAuthTag,
        },
        orgKey,
        blobAad
      )
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to decrypt entry data" },
      { status: 500 }
    );
  }

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

  if (entry.entryType === "CREDIT_CARD") {
    return NextResponse.json({
      ...common,
      cardholderName: blob.cardholderName ?? null,
      cardNumber: blob.cardNumber ?? null,
      brand: blob.brand ?? null,
      expiryMonth: blob.expiryMonth ?? null,
      expiryYear: blob.expiryYear ?? null,
      cvv: blob.cvv ?? null,
      notes: blob.notes ?? null,
    });
  }

  if (entry.entryType === "IDENTITY") {
    return NextResponse.json({
      ...common,
      fullName: blob.fullName ?? null,
      address: blob.address ?? null,
      phone: blob.phone ?? null,
      email: blob.email ?? null,
      dateOfBirth: blob.dateOfBirth ?? null,
      nationality: blob.nationality ?? null,
      idNumber: blob.idNumber ?? null,
      issueDate: blob.issueDate ?? null,
      expiryDate: blob.expiryDate ?? null,
      notes: blob.notes ?? null,
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

  // Decrypt current blob (with AAD if entry was encrypted with it)
  const currentBlobAad = entry.aadVersion >= 1
    ? Buffer.from(buildOrgEntryAAD(orgId, id, "blob"))
    : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentBlob: Record<string, any>;
  try {
    currentBlob = JSON.parse(
      decryptServerData(
        {
          ciphertext: entry.encryptedBlob,
          iv: entry.blobIv,
          authTag: entry.blobAuthTag,
        },
        orgKey,
        currentBlobAad
      )
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to decrypt entry data" },
      { status: 500 }
    );
  }

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
  } else if (entry.entryType === "CREDIT_CARD") {
    const parsed = updateOrgCreditCardSchema.safeParse(body);
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
      cardholderName:
        parsed.data.cardholderName !== undefined
          ? parsed.data.cardholderName || null
          : currentBlob.cardholderName,
      cardNumber:
        parsed.data.cardNumber !== undefined
          ? parsed.data.cardNumber || null
          : currentBlob.cardNumber,
      brand:
        parsed.data.brand !== undefined
          ? parsed.data.brand || null
          : currentBlob.brand,
      expiryMonth:
        parsed.data.expiryMonth !== undefined
          ? parsed.data.expiryMonth || null
          : currentBlob.expiryMonth,
      expiryYear:
        parsed.data.expiryYear !== undefined
          ? parsed.data.expiryYear || null
          : currentBlob.expiryYear,
      cvv:
        parsed.data.cvv !== undefined
          ? parsed.data.cvv || null
          : currentBlob.cvv,
      notes:
        parsed.data.notes !== undefined
          ? parsed.data.notes || null
          : currentBlob.notes,
    };
    responseTitle = updatedBlob.title;

    const lastFour = updatedBlob.cardNumber
      ? updatedBlob.cardNumber.slice(-4)
      : null;
    updatedBlobStr = JSON.stringify(updatedBlob);
    overviewBlobStr = JSON.stringify({
      title: updatedBlob.title,
      cardholderName: updatedBlob.cardholderName,
      brand: updatedBlob.brand,
      lastFour,
    });
  } else if (entry.entryType === "IDENTITY") {
    const parsed = updateOrgIdentitySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    tagIds = parsed.data.tagIds;
    isArchived = parsed.data.isArchived;

    const mergeField = (field: string) =>
      (parsed.data as Record<string, unknown>)[field] !== undefined
        ? (parsed.data as Record<string, unknown>)[field] || null
        : currentBlob[field];

    const updatedBlob = {
      title: parsed.data.title ?? currentBlob.title,
      fullName: mergeField("fullName"),
      address: mergeField("address"),
      phone: mergeField("phone"),
      email: mergeField("email"),
      dateOfBirth: mergeField("dateOfBirth"),
      nationality: mergeField("nationality"),
      idNumber: mergeField("idNumber"),
      issueDate: mergeField("issueDate"),
      expiryDate: mergeField("expiryDate"),
      notes: mergeField("notes"),
    };
    responseTitle = updatedBlob.title;

    if (
      updatedBlob.issueDate &&
      updatedBlob.expiryDate &&
      (updatedBlob.issueDate as string) >= (updatedBlob.expiryDate as string)
    ) {
      return NextResponse.json(
        { error: "Expiry date must be after issue date" },
        { status: 400 }
      );
    }

    const idNumberLast4 = updatedBlob.idNumber
      ? (updatedBlob.idNumber as string).slice(-4)
      : null;
    updatedBlobStr = JSON.stringify(updatedBlob);
    overviewBlobStr = JSON.stringify({
      title: updatedBlob.title,
      fullName: updatedBlob.fullName,
      idNumberLast4,
    });
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

  // Always re-encrypt with AAD (save-time migration for legacy entries)
  const blobAad = Buffer.from(buildOrgEntryAAD(orgId, id, "blob"));
  const overviewAad = Buffer.from(buildOrgEntryAAD(orgId, id, "overview"));

  const encryptedBlob = encryptServerData(updatedBlobStr, orgKey, blobAad);
  const encryptedOverview = encryptServerData(overviewBlobStr, orgKey, overviewAad);

  const updateData: Record<string, unknown> = {
    encryptedBlob: encryptedBlob.ciphertext,
    blobIv: encryptedBlob.iv,
    blobAuthTag: encryptedBlob.authTag,
    encryptedOverview: encryptedOverview.ciphertext,
    overviewIv: encryptedOverview.iv,
    overviewAuthTag: encryptedOverview.authTag,
    aadVersion: AAD_VERSION,
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

  logAudit({
    scope: "ORG",
    action: "ENTRY_UPDATE",
    userId: session.user.id,
    orgId,
    targetType: "OrgPasswordEntry",
    targetId: id,
    ...extractRequestMeta(req),
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

  logAudit({
    scope: "ORG",
    action: "ENTRY_DELETE",
    userId: session.user.id,
    orgId,
    targetType: "OrgPasswordEntry",
    targetId: id,
    metadata: { permanent },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
