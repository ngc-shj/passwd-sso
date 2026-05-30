import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateTeamSchema } from "@/lib/validations";
import {
  requireTeamMember,
  requireTeamPermission,
  TeamAuthError,
} from "@/lib/auth/access/team-auth";
import { parseBody } from "@/lib/http/parse-body";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withTenantRls } from "@/lib/tenant-rls";
import {
  collectEntryAttachmentRefs,
  deleteAttachmentBlobs,
  type AttachmentBlobRef,
} from "@/lib/blob-store/cleanup";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma/prisma-filters";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string }> };

function handleTeamTenantError(e: unknown): NextResponse | null {
  if (e instanceof Error && e.message === "TENANT_NOT_RESOLVED") {
    return notFound();
  }
  if (e instanceof TeamAuthError) {
    return errorResponse(e.message, e.status);
  }
  return null;
}

// GET /api/teams/[teamId] — Get team details
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    const membership = await requireTeamMember(session.user.id, teamId, req);
    const team = await withTeamTenantRls(teamId, async () =>
      prisma.team.findUnique({
        where: { id: teamId },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { members: true, passwords: { where: { ...ACTIVE_ENTRY_WHERE } } } },
          tenant: { select: { name: true } },
        },
      }),
    );

    if (!team) {
      return notFound();
    }

    return NextResponse.json({
      ...team,
      tenantName: team.tenant.name,
      role: membership.role,
      memberCount: team._count.members,
      passwordCount: team._count.passwords,
    });
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }
}

// PUT /api/teams/[teamId] — Update team
async function handlePUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }

  const result = await parseBody(req, updateTeamSchema);
  if (!result.ok) return result.response;

  const updateData: Record<string, unknown> = {};
  if (result.data.name !== undefined) updateData.name = result.data.name;
  if (result.data.description !== undefined) {
    updateData.description = result.data.description || null;
  }

  let team;
  try {
    team = await withTeamTenantRls(teamId, async () =>
      prisma.team.update({
        where: { id: teamId },
        data: updateData,
      }),
    );
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }

  return NextResponse.json({
    id: team.id,
    name: team.name,
    slug: team.slug,
    description: team.description,
    updatedAt: team.updatedAt,
  });
}

// DELETE /api/teams/[teamId] — Delete team (OWNER only)
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_DELETE, req);
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }

  let attachmentRefs: AttachmentBlobRef[];
  try {
    attachmentRefs = await withTeamTenantRls(teamId, async (tenantId) =>
      withTenantRls(prisma, tenantId, async (tx) => {
        const entries = await tx.teamPasswordEntry.findMany({
          where: { teamId },
          select: { id: true },
        });
        // Capture external blob refs before the cascade delete removes the rows
        const refs = await collectEntryAttachmentRefs(tx, {
          kind: "team",
          teamId,
          entryIds: entries.map((e) => e.id),
        });
        await tx.team.delete({ where: { id: teamId } });
        return refs;
      }),
    );
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }

  await deleteAttachmentBlobs(attachmentRefs);

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
