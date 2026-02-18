import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createE2EPasswordSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { authOrToken } from "@/lib/auth-or-token";
import { withRequestLog } from "@/lib/with-request-log";
import type { EntryType } from "@prisma/client";
import { ENTRY_TYPE_VALUES, EXTENSION_TOKEN_SCOPE, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

const VALID_ENTRY_TYPES: Set<string> = new Set(ENTRY_TYPE_VALUES);

// GET /api/passwords - List passwords (returns encrypted overviews)
async function handleGET(req: NextRequest) {
  const authResult = await authOrToken(req, EXTENSION_TOKEN_SCOPE.PASSWORDS_READ);
  if (authResult?.type === "scope_insufficient") {
    return NextResponse.json({ error: API_ERROR.EXTENSION_TOKEN_SCOPE_INSUFFICIENT }, { status: 403 });
  }
  if (!authResult) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  const userId = authResult.userId;

  const { searchParams } = new URL(req.url);
  const tagId = searchParams.get("tag");
  const rawType = searchParams.get("type");
  const entryType = rawType && VALID_ENTRY_TYPES.has(rawType) ? (rawType as EntryType) : null;
  const includeBlob = searchParams.get("include") === "blob";
  const favoritesOnly = searchParams.get("favorites") === "true";
  const trashOnly = searchParams.get("trash") === "true";
  const archivedOnly = searchParams.get("archived") === "true";
  const folderId = searchParams.get("folder");

  const passwords = await prisma.passwordEntry.findMany({
    where: {
      userId,
      ...(trashOnly
        ? { deletedAt: { not: null } }
        : { deletedAt: null }),
      ...(archivedOnly
        ? { isArchived: true }
        : trashOnly ? {} : { isArchived: false }),
      ...(favoritesOnly ? { isFavorite: true } : {}),
      ...(tagId ? { tags: { some: { id: tagId } } } : {}),
      ...(entryType ? { entryType } : {}),
      ...(folderId ? { folderId } : {}),
    },
    include: { tags: { select: { id: true } } },
    orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }],
  });

  // Auto-purge items deleted more than 30 days ago
  if (!trashOnly) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.passwordEntry.deleteMany({
      where: {
        userId,
        deletedAt: { lt: thirtyDaysAgo },
      },
    }).catch(() => {});
  }

  // Return encrypted overviews (and optionally blobs) for client-side decryption
  const entries = passwords.map((entry) => ({
    id: entry.id,
    encryptedOverview: {
      ciphertext: entry.encryptedOverview,
      iv: entry.overviewIv,
      authTag: entry.overviewAuthTag,
    },
    ...(includeBlob
      ? {
          encryptedBlob: {
            ciphertext: entry.encryptedBlob,
            iv: entry.blobIv,
            authTag: entry.blobAuthTag,
          },
        }
      : {}),
    keyVersion: entry.keyVersion,
    aadVersion: entry.aadVersion,
    entryType: entry.entryType,
    isFavorite: entry.isFavorite,
    isArchived: entry.isArchived,
    requireReprompt: entry.requireReprompt,
    folderId: entry.folderId,
    tagIds: entry.tags.map((t) => t.id),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: entry.deletedAt,
  }));

  return NextResponse.json(entries);
}

// POST /api/passwords - Create new password entry (E2E encrypted)
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = createE2EPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id: clientId, encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, folderId, entryType, requireReprompt } = parsed.data;

  const entry = await prisma.passwordEntry.create({
    data: {
      ...(clientId ? { id: clientId } : {}),
      encryptedBlob: encryptedBlob.ciphertext,
      blobIv: encryptedBlob.iv,
      blobAuthTag: encryptedBlob.authTag,
      encryptedOverview: encryptedOverview.ciphertext,
      overviewIv: encryptedOverview.iv,
      overviewAuthTag: encryptedOverview.authTag,
      keyVersion,
      aadVersion,
      entryType,
      ...(requireReprompt !== undefined ? { requireReprompt } : {}),
      ...(folderId ? { folderId } : {}),
      userId: session.user.id,
      ...(tagIds?.length
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
    },
    include: { tags: { select: { id: true } } },
  });

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_CREATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: entry.id,
    metadata: (() => {
      if (req.headers.get("x-passwd-sso-source") !== "import") return undefined;
      const rawFilename = req.headers.get("x-passwd-sso-filename")?.trim() ?? "";
      const filename = rawFilename
        ? rawFilename
            .replace(/[\0\x01-\x1f\x7f-\x9f]/g, "") // null bytes + control chars
            .replace(/[/\\]/g, "_")                    // path separators → underscore
            .trim()
            .slice(0, 255) || undefined
        : undefined;
      return filename
        ? {
            source: "import",
            filename,
            parentAction: AUDIT_ACTION.ENTRY_IMPORT,
          }
        : {
            source: "import",
            parentAction: AUDIT_ACTION.ENTRY_IMPORT,
          };
    })(),
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      id: entry.id,
      encryptedOverview: {
        ciphertext: entry.encryptedOverview,
        iv: entry.overviewIv,
        authTag: entry.overviewAuthTag,
      },
      keyVersion: entry.keyVersion,
      aadVersion: entry.aadVersion,
      entryType: entry.entryType,
      requireReprompt: entry.requireReprompt,
      tagIds: entry.tags.map((t) => t.id),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    { status: 201 }
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
