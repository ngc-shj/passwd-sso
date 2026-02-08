import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createOrgPasswordSchema } from "@/lib/validations";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import {
  unwrapOrgKey,
  encryptServerData,
  decryptServerData,
} from "@/lib/crypto-server";

type Params = { params: Promise<{ orgId: string }> };

// GET /api/orgs/[orgId]/passwords — List org passwords (server decrypts overviews)
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "password:read");
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const tagId = searchParams.get("tag");
  const favoritesOnly = searchParams.get("favorites") === "true";
  const trashOnly = searchParams.get("trash") === "true";
  const archivedOnly = searchParams.get("archived") === "true";

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      encryptedOrgKey: true,
      orgKeyIv: true,
      orgKeyAuthTag: true,
    },
  });

  if (!org) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }

  const orgKey = unwrapOrgKey({
    ciphertext: org.encryptedOrgKey,
    iv: org.orgKeyIv,
    authTag: org.orgKeyAuthTag,
  });

  const passwords = await prisma.orgPasswordEntry.findMany({
    where: {
      orgId,
      ...(trashOnly
        ? { deletedAt: { not: null } }
        : { deletedAt: null }),
      ...(archivedOnly
        ? { isArchived: true }
        : trashOnly ? {} : { isArchived: false }),
      ...(favoritesOnly ? { isFavorite: true } : {}),
      ...(tagId ? { tags: { some: { id: tagId } } } : {}),
    },
    include: {
      tags: { select: { id: true, name: true, color: true } },
      createdBy: { select: { id: true, name: true, image: true } },
      updatedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }],
  });

  // Auto-purge items deleted more than 30 days ago
  if (!trashOnly) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.orgPasswordEntry.deleteMany({
      where: {
        orgId,
        deletedAt: { lt: thirtyDaysAgo },
      },
    }).catch(() => {});
  }

  const entries = passwords.map((entry) => {
    const overview = JSON.parse(
      decryptServerData(
        {
          ciphertext: entry.encryptedOverview,
          iv: entry.overviewIv,
          authTag: entry.overviewAuthTag,
        },
        orgKey
      )
    );

    return {
      id: entry.id,
      title: overview.title,
      username: overview.username,
      urlHost: overview.urlHost,
      isFavorite: entry.isFavorite,
      isArchived: entry.isArchived,
      tags: entry.tags,
      createdBy: entry.createdBy,
      updatedBy: entry.updatedBy,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      deletedAt: entry.deletedAt,
    };
  });

  return NextResponse.json(entries);
}

// POST /api/orgs/[orgId]/passwords — Create org password (plaintext in, server encrypts)
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "password:create");
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createOrgPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { title, username, password, url, notes, tagIds } = parsed.data;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      encryptedOrgKey: true,
      orgKeyIv: true,
      orgKeyAuthTag: true,
    },
  });

  if (!org) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }

  const orgKey = unwrapOrgKey({
    ciphertext: org.encryptedOrgKey,
    iv: org.orgKeyIv,
    authTag: org.orgKeyAuthTag,
  });

  let urlHost: string | null = null;
  if (url) {
    try {
      urlHost = new URL(url).hostname;
    } catch {
      /* invalid url */
    }
  }

  const fullBlob = JSON.stringify({
    title,
    username: username || null,
    password,
    url: url || null,
    notes: notes || null,
  });

  const overviewBlob = JSON.stringify({
    title,
    username: username || null,
    urlHost,
  });

  const encryptedBlob = encryptServerData(fullBlob, orgKey);
  const encryptedOverview = encryptServerData(overviewBlob, orgKey);

  const entry = await prisma.orgPasswordEntry.create({
    data: {
      encryptedBlob: encryptedBlob.ciphertext,
      blobIv: encryptedBlob.iv,
      blobAuthTag: encryptedBlob.authTag,
      encryptedOverview: encryptedOverview.ciphertext,
      overviewIv: encryptedOverview.iv,
      overviewAuthTag: encryptedOverview.authTag,
      orgId,
      createdById: session.user.id,
      updatedById: session.user.id,
      ...(tagIds?.length
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
    },
    include: {
      tags: { select: { id: true, name: true, color: true } },
    },
  });

  return NextResponse.json(
    {
      id: entry.id,
      title,
      username: username || null,
      urlHost,
      tags: entry.tags,
      createdAt: entry.createdAt,
    },
    { status: 201 }
  );
}
