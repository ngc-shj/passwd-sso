import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import {
  createOrgPasswordSchema,
  createOrgSecureNoteSchema,
  createOrgCreditCardSchema,
  createOrgIdentitySchema,
  createOrgPasskeySchema,
} from "@/lib/validations";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import type { EntryType } from "@prisma/client";
import {
  unwrapOrgKey,
  encryptServerData,
  decryptServerData,
} from "@/lib/crypto-server";
import { buildOrgEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { ENTRY_TYPE, ENTRY_TYPE_VALUES, ORG_PERMISSION, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string }> };

const VALID_ENTRY_TYPES: Set<string> = new Set(ENTRY_TYPE_VALUES);

// GET /api/orgs/[orgId]/passwords — List org passwords (server decrypts overviews)
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const tagId = searchParams.get("tag");
  const folderId = searchParams.get("folder");
  const rawType = searchParams.get("type");
  const entryType = rawType && VALID_ENTRY_TYPES.has(rawType) ? (rawType as EntryType) : null;
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
    return NextResponse.json({ error: API_ERROR.ORG_NOT_FOUND }, { status: 404 });
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
      ...(favoritesOnly
        ? { favorites: { some: { userId: session.user.id } } }
        : {}),
      ...(tagId ? { tags: { some: { id: tagId } } } : {}),
      ...(folderId ? { orgFolderId: folderId } : {}),
      ...(entryType ? { entryType } : {}),
    },
    include: {
      tags: { select: { id: true, name: true, color: true } },
      createdBy: { select: { id: true, name: true, image: true } },
      updatedBy: { select: { id: true, name: true } },
      favorites: {
        where: { userId: session.user.id },
        select: { id: true },
      },
    },
    orderBy: { updatedAt: "desc" },
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

  interface OrgPasswordListEntry {
    id: string;
    entryType: string;
    title: string;
    username: string | null;
    urlHost: string | null;
    snippet: string | null;
    brand: string | null;
    lastFour: string | null;
    cardholderName: string | null;
    fullName: string | null;
    idNumberLast4: string | null;
    isFavorite: boolean;
    isArchived: boolean;
    tags: { id: string; name: string; color: string | null }[];
    createdBy: { id: string; name: string | null; image: string | null };
    updatedBy: { id: string; name: string | null };
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }

  const entries: OrgPasswordListEntry[] = [];
  for (const entry of passwords) {
    try {
      const aad = entry.aadVersion >= 1
        ? Buffer.from(buildOrgEntryAAD(orgId, entry.id, "overview"))
        : undefined;
      const overview = JSON.parse(
        decryptServerData(
          {
            ciphertext: entry.encryptedOverview,
            iv: entry.overviewIv,
            authTag: entry.overviewAuthTag,
          },
          orgKey,
          aad
        )
      );

      entries.push({
        id: entry.id,
        entryType: entry.entryType,
        title: overview.title,
        username: overview.username ?? null,
        urlHost: overview.urlHost ?? null,
        snippet: overview.snippet ?? null,
        brand: overview.brand ?? null,
        lastFour: overview.lastFour ?? null,
        cardholderName: overview.cardholderName ?? null,
        fullName: overview.fullName ?? null,
        idNumberLast4: overview.idNumberLast4 ?? null,
        isFavorite: entry.favorites.length > 0,
        isArchived: entry.isArchived,
        tags: entry.tags,
        createdBy: entry.createdBy,
        updatedBy: entry.updatedBy,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        deletedAt: entry.deletedAt,
      });
    } catch {
      // Skip entries with corrupt encrypted data rather than failing the entire list
      continue;
    }
  }

  // Sort: favorites first, then by updatedAt desc
  entries.sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return NextResponse.json(entries);
}

// POST /api/orgs/[orgId]/passwords — Create org password (plaintext in, server encrypts)
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.PASSWORD_CREATE);
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
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  // Check entry type
  const rawBody = body as Record<string, unknown>;
  const isSecureNote = rawBody.entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = rawBody.entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = rawBody.entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = rawBody.entryType === ENTRY_TYPE.PASSKEY;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      encryptedOrgKey: true,
      orgKeyIv: true,
      orgKeyAuthTag: true,
    },
  });

  if (!org) {
    return NextResponse.json({ error: API_ERROR.ORG_NOT_FOUND }, { status: 404 });
  }

  const orgKey = unwrapOrgKey({
    ciphertext: org.encryptedOrgKey,
    iv: org.orgKeyIv,
    authTag: org.orgKeyAuthTag,
  });

  let fullBlob: string;
  let overviewBlob: string;
  let entryType: EntryTypeValue = ENTRY_TYPE.LOGIN;
  let tagIds: string[] | undefined;
  let orgFolderId: string | null | undefined;
  let responseTitle: string;
  let responseUsername: string | null = null;
  let responseUrlHost: string | null = null;

  if (isSecureNote) {
    const parsed = createOrgSecureNoteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { title, content } = parsed.data;
    tagIds = parsed.data.tagIds;
    orgFolderId = parsed.data.orgFolderId;
    entryType = ENTRY_TYPE.SECURE_NOTE;
    responseTitle = title;

    const snippet = content.slice(0, 100);
    fullBlob = JSON.stringify({ title, content });
    overviewBlob = JSON.stringify({ title, snippet });
  } else if (isCreditCard) {
    const parsed = createOrgCreditCardSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { title, cardholderName, cardNumber, brand, expiryMonth, expiryYear, cvv, notes } = parsed.data;
    tagIds = parsed.data.tagIds;
    orgFolderId = parsed.data.orgFolderId;
    entryType = ENTRY_TYPE.CREDIT_CARD;
    responseTitle = title;

    const lastFour = cardNumber ? cardNumber.slice(-4) : null;
    fullBlob = JSON.stringify({
      title,
      cardholderName: cardholderName || null,
      cardNumber: cardNumber || null,
      brand: brand || null,
      expiryMonth: expiryMonth || null,
      expiryYear: expiryYear || null,
      cvv: cvv || null,
      notes: notes || null,
    });
    overviewBlob = JSON.stringify({
      title,
      cardholderName: cardholderName || null,
      brand: brand || null,
      lastFour,
    });
  } else if (isIdentity) {
    const parsed = createOrgIdentitySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { title, fullName, address, phone, email, dateOfBirth, nationality, idNumber, issueDate, expiryDate, notes } = parsed.data;
    tagIds = parsed.data.tagIds;
    orgFolderId = parsed.data.orgFolderId;
    entryType = ENTRY_TYPE.IDENTITY;
    responseTitle = title;

    const idNumberLast4 = idNumber ? idNumber.slice(-4) : null;
    fullBlob = JSON.stringify({
      title,
      fullName: fullName || null,
      address: address || null,
      phone: phone || null,
      email: email || null,
      dateOfBirth: dateOfBirth || null,
      nationality: nationality || null,
      idNumber: idNumber || null,
      issueDate: issueDate || null,
      expiryDate: expiryDate || null,
      notes: notes || null,
    });
    overviewBlob = JSON.stringify({
      title,
      fullName: fullName || null,
      idNumberLast4,
    });
  } else if (isPasskey) {
    const parsed = createOrgPasskeySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const {
      title,
      relyingPartyId,
      relyingPartyName,
      username,
      credentialId,
      creationDate,
      deviceInfo,
      notes,
    } = parsed.data;
    tagIds = parsed.data.tagIds;
    orgFolderId = parsed.data.orgFolderId;
    entryType = ENTRY_TYPE.PASSKEY;
    responseTitle = title;
    responseUsername = username || null;

    fullBlob = JSON.stringify({
      title,
      relyingPartyId: relyingPartyId || null,
      relyingPartyName: relyingPartyName || null,
      username: username || null,
      credentialId: credentialId || null,
      creationDate: creationDate || null,
      deviceInfo: deviceInfo || null,
      notes: notes || null,
    });
    overviewBlob = JSON.stringify({
      title,
      relyingPartyId: relyingPartyId || null,
      username: username || null,
    });
  } else {
    const parsed = createOrgPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { title, username, password, url, notes, customFields, totp } = parsed.data;
    tagIds = parsed.data.tagIds;
    orgFolderId = parsed.data.orgFolderId;
    responseTitle = title;
    responseUsername = username || null;

    let urlHost: string | null = null;
    if (url) {
      try {
        urlHost = new URL(url).hostname;
      } catch {
        /* invalid url */
      }
    }
    responseUrlHost = urlHost;

    fullBlob = JSON.stringify({
      title,
      username: username || null,
      password,
      url: url || null,
      notes: notes || null,
      ...(customFields?.length ? { customFields } : {}),
      ...(totp ? { totp } : {}),
    });

    overviewBlob = JSON.stringify({
      title,
      username: username || null,
      urlHost,
    });
  }

  // Validate orgFolderId belongs to this org
  if (orgFolderId) {
    const folder = await prisma.orgFolder.findUnique({
      where: { id: orgFolderId },
      select: { orgId: true },
    });
    if (!folder || folder.orgId !== orgId) {
      return NextResponse.json({ error: API_ERROR.FOLDER_NOT_FOUND }, { status: 400 });
    }
  }

  // Pre-generate entry ID for AAD binding
  const entryId = crypto.randomUUID();
  const blobAad = Buffer.from(buildOrgEntryAAD(orgId, entryId, "blob"));
  const overviewAad = Buffer.from(buildOrgEntryAAD(orgId, entryId, "overview"));

  const encryptedBlob = encryptServerData(fullBlob, orgKey, blobAad);
  const encryptedOverview = encryptServerData(overviewBlob, orgKey, overviewAad);

  const entry = await prisma.orgPasswordEntry.create({
    data: {
      id: entryId,
      encryptedBlob: encryptedBlob.ciphertext,
      blobIv: encryptedBlob.iv,
      blobAuthTag: encryptedBlob.authTag,
      encryptedOverview: encryptedOverview.ciphertext,
      overviewIv: encryptedOverview.iv,
      overviewAuthTag: encryptedOverview.authTag,
      aadVersion: AAD_VERSION,
      entryType,
      orgId,
      createdById: session.user.id,
      updatedById: session.user.id,
      ...(orgFolderId ? { orgFolderId } : {}),
      ...(tagIds?.length
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
    },
    include: {
      tags: { select: { id: true, name: true, color: true } },
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.ENTRY_CREATE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_PASSWORD_ENTRY,
    targetId: entry.id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      id: entry.id,
      entryType: entry.entryType,
      title: responseTitle,
      username: responseUsername,
      urlHost: responseUrlHost,
      tags: entry.tags,
      createdAt: entry.createdAt,
    },
    { status: 201 }
  );
}
