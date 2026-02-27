import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateTeamE2EPasswordSchema } from "@/lib/validations";
import {
  requireTeamPermission,
  requireTeamMember,
  hasTeamPermission,
  TeamAuthError,
} from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, TEAM_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string; id: string }> };

// GET /api/teams/[teamId]/passwords/[id] — Get password detail (encrypted blob, client decrypts)
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      include: {
        tags: { select: { id: true, name: true, color: true } },
        createdBy: { select: { id: true, name: true, image: true } },
        updatedBy: { select: { id: true, name: true } },
        favorites: {
          where: { userId: session.user.id },
          select: { id: true },
        },
      },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  return NextResponse.json({
    id: entry.id,
    entryType: entry.entryType,
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    teamFolderId: entry.teamFolderId,
    tags: entry.tags,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    encryptedBlob: entry.encryptedBlob,
    blobIv: entry.blobIv,
    blobAuthTag: entry.blobAuthTag,
    encryptedOverview: entry.encryptedOverview,
    overviewIv: entry.overviewIv,
    overviewAuthTag: entry.overviewAuthTag,
    aadVersion: entry.aadVersion,
    teamKeyVersion: entry.teamKeyVersion,
  });
}

// PUT /api/teams/[teamId]/passwords/[id] — Update password (E2E: full blob replacement)
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  let membership;
  try {
    membership = await withUserTenantRls(session.user.id, async () =>
      requireTeamMember(session.user.id, teamId),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: {
        teamId: true,
        createdById: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        aadVersion: true,
        teamKeyVersion: true,
      },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // MEMBER can only update their own entries
  if (!hasTeamPermission(membership.role, TEAM_PERMISSION.PASSWORD_UPDATE)) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }
  if (
    membership.role === TEAM_ROLE.MEMBER &&
    entry.createdById !== session.user.id
  ) {
    return NextResponse.json(
      { error: API_ERROR.ONLY_OWN_ENTRIES },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = updateTeamE2EPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { encryptedBlob, encryptedOverview, aadVersion, teamKeyVersion, tagIds, teamFolderId, isArchived } = parsed.data;
  const isFullUpdate = encryptedBlob !== undefined;

  // Validate teamKeyVersion matches current team key version (F-13)
  if (isFullUpdate) {
    const team = await withUserTenantRls(session.user.id, async () =>
      prisma.team.findUnique({
        where: { id: teamId },
        select: { teamKeyVersion: true },
      }),
    );
    if (!team || teamKeyVersion !== team.teamKeyVersion) {
      return NextResponse.json(
        { error: API_ERROR.TEAM_KEY_VERSION_MISMATCH },
        { status: 409 }
      );
    }
  }

  // Validate teamFolderId belongs to this team
  if (teamFolderId) {
    const folder = await withUserTenantRls(session.user.id, async () =>
      prisma.teamFolder.findUnique({
        where: { id: teamFolderId },
        select: { teamId: true },
      }),
    );
    if (!folder || folder.teamId !== teamId) {
      return NextResponse.json({ error: API_ERROR.FOLDER_NOT_FOUND }, { status: 400 });
    }
  }

  const updateData: Record<string, unknown> = {
    updatedById: session.user.id,
  };

  if (isFullUpdate) {
    updateData.encryptedBlob = encryptedBlob!.ciphertext;
    updateData.blobIv = encryptedBlob!.iv;
    updateData.blobAuthTag = encryptedBlob!.authTag;
    updateData.encryptedOverview = encryptedOverview!.ciphertext;
    updateData.overviewIv = encryptedOverview!.iv;
    updateData.overviewAuthTag = encryptedOverview!.authTag;
    updateData.aadVersion = aadVersion;
    updateData.teamKeyVersion = teamKeyVersion;
  }

  if (teamFolderId !== undefined) updateData.teamFolderId = teamFolderId;
  if (isArchived !== undefined) updateData.isArchived = isArchived;
  if (tagIds !== undefined) {
    updateData.tags = { set: tagIds.map((tid) => ({ id: tid })) };
  }

  // Snapshot + update in a single transaction for atomicity (F-9)
  const updated = await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction(async (tx) => {
      if (isFullUpdate) {
        await tx.teamPasswordEntryHistory.create({
          data: {
            entryId: id,
            encryptedBlob: entry.encryptedBlob,
            blobIv: entry.blobIv,
            blobAuthTag: entry.blobAuthTag,
            aadVersion: entry.aadVersion,
            teamKeyVersion: entry.teamKeyVersion,
            changedById: session.user.id,
          },
        });
        const all = await tx.teamPasswordEntryHistory.findMany({
          where: { entryId: id },
          orderBy: [{ changedAt: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (all.length > 20) {
          await tx.teamPasswordEntryHistory.deleteMany({
            where: { id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
          });
        }
      }

      return tx.teamPasswordEntry.update({
        where: { id, teamId: teamId },
        data: updateData,
        include: {
          tags: { select: { id: true, name: true, color: true } },
        },
      });
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_UPDATE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({
    id: updated.id,
    entryType: updated.entryType,
    tags: updated.tags,
    updatedAt: updated.updatedAt,
  });
}

// DELETE /api/teams/[teamId]/passwords/[id] — Soft delete (move to trash)
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
    }),
  );

  if (!existing || existing.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  if (permanent) {
    await withUserTenantRls(session.user.id, async () =>
      prisma.teamPasswordEntry.delete({ where: { id } }),
    );
  } else {
    await withUserTenantRls(session.user.id, async () =>
      prisma.teamPasswordEntry.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    );
  }

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_DELETE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    metadata: { permanent },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
