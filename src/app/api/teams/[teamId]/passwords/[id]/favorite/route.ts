import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; id: string }> };

// POST /api/teams/[teamId]/passwords/[id]/favorite — Toggle per-user favorite
async function handlePOST(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  // Verify the password belongs to this team
  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true, tenantId: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  // Toggle: if exists, remove; if not, create
  const existing = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordFavorite.findUnique({
      where: {
        userId_teamPasswordEntryId: {
          userId: session.user.id,
          teamPasswordEntryId: id,
        },
      },
    }),
  );

  if (existing) {
    await withTeamTenantRls(teamId, async () =>
      prisma.teamPasswordFavorite.delete({
        where: { id: existing.id },
      }),
    );
    return NextResponse.json({ isFavorite: false });
  } else {
    try {
      await withTeamTenantRls(teamId, async () =>
        prisma.teamPasswordFavorite.create({
          data: {
            userId: session.user.id,
            teamPasswordEntryId: id,
            tenantId: entry.tenantId,
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return NextResponse.json({ isFavorite: true });
      }
      throw error;
    }
    return NextResponse.json({ isFavorite: true });
  }
}

export const POST = withRequestLog(handlePOST);
