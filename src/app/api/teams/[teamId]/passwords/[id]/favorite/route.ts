import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/team-auth";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string; id: string }> };

// POST /api/teams/[teamId]/passwords/[id]/favorite — Toggle per-user favorite
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // Verify the password belongs to this team and load existing favorite in one query
  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: {
        teamId: true,
        tenantId: true,
        favorites: {
          where: { userId: session.user.id },
          select: { id: true },
          take: 1,
        },
      },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const existing = entry.favorites[0] ?? null;

  if (existing) {
    await withTeamTenantRls(teamId, async () =>
      prisma.teamPasswordFavorite.deleteMany({
        where: { userId: session.user.id, teamPasswordEntryId: id },
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
