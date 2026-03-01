import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createTeamE2EPasswordSchema } from "@/lib/validations";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import type { EntryType } from "@prisma/client";
import { ENTRY_TYPE_VALUES, TEAM_PERMISSION, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string }> };

const VALID_ENTRY_TYPES: Set<string> = new Set(ENTRY_TYPE_VALUES);

// GET /api/teams/[teamId]/passwords — List team passwords (encrypted overviews, client decrypts)
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof TeamAuthError) {
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

  const passwords = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId: teamId,
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
        ...(folderId ? { teamFolderId: folderId } : {}),
        ...(entryType ? { entryType } : {}),
      },
      include: {
        tags: { select: { id: true, name: true, color: true } },
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
        favorites: {
          where: { userId: session.user.id },
          select: { id: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
  );

  // Auto-purge items deleted more than 30 days ago (async nonblocking, F-20)
  if (!trashOnly) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    withTeamTenantRls(teamId, async () =>
      prisma.teamPasswordEntry.deleteMany({
        where: {
          teamId: teamId,
          deletedAt: { lt: thirtyDaysAgo },
        },
      }),
    ).catch(() => {});
  }

  const entries = passwords.map((entry) => ({
    id: entry.id,
    entryType: entry.entryType,
    encryptedOverview: entry.encryptedOverview,
    overviewIv: entry.overviewIv,
    overviewAuthTag: entry.overviewAuthTag,
    aadVersion: entry.aadVersion,
    teamKeyVersion: entry.teamKeyVersion,
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    tags: entry.tags,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: entry.deletedAt,
    requireReprompt: entry.requireReprompt,
    expiresAt: entry.expiresAt,
  }));

  // Sort: favorites first, then by updatedAt desc
  entries.sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return NextResponse.json(entries);
}

// POST /api/teams/[teamId]/passwords — Create team password (E2E: client encrypts)
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_CREATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
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

  const parsed = createTeamE2EPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id: clientId, encryptedBlob, encryptedOverview, aadVersion, teamKeyVersion, entryType, tagIds, teamFolderId, requireReprompt, expiresAt } = parsed.data;

  // Validate teamKeyVersion matches current team key version
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { teamKeyVersion: true, tenantId: true },
    }),
  );
  if (!team || teamKeyVersion !== team.teamKeyVersion) {
    return NextResponse.json(
      { error: API_ERROR.TEAM_KEY_VERSION_MISMATCH },
      { status: 409 }
    );
  }

  // Validate teamFolderId belongs to this team
  if (teamFolderId) {
    const folder = await withTeamTenantRls(teamId, async () =>
      prisma.teamFolder.findUnique({
        where: { id: teamFolderId },
        select: { teamId: true },
      }),
    );
    if (!folder || folder.teamId !== teamId) {
      return NextResponse.json({ error: API_ERROR.FOLDER_NOT_FOUND }, { status: 400 });
    }
  }

  // Use client-provided ID (bound into AAD during encryption) or generate one
  const entryId = clientId ?? crypto.randomUUID();

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.create({
      data: {
        id: entryId,
        encryptedBlob: encryptedBlob.ciphertext,
        blobIv: encryptedBlob.iv,
        blobAuthTag: encryptedBlob.authTag,
        encryptedOverview: encryptedOverview.ciphertext,
        overviewIv: encryptedOverview.iv,
        overviewAuthTag: encryptedOverview.authTag,
        aadVersion,
        teamKeyVersion: teamKeyVersion,
        entryType,
        teamId: teamId,
        tenantId: team.tenantId,
        createdById: session.user.id,
        updatedById: session.user.id,
        ...(requireReprompt !== undefined ? { requireReprompt } : {}),
        ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
        ...(teamFolderId ? { teamFolderId: teamFolderId } : {}),
        ...(tagIds?.length
          ? { tags: { connect: tagIds.map((id) => ({ id })) } }
          : {}),
      },
      include: {
        tags: { select: { id: true, name: true, color: true } },
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_CREATE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: entry.id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      id: entry.id,
      entryType: entry.entryType,
      tags: entry.tags,
      createdAt: entry.createdAt,
    },
    { status: 201 }
  );
}
