import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, INVITATION_STATUS } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized } from "@/lib/api-response";
import { SEARCH_QUERY_MAX_LENGTH } from "@/lib/validations/common";

type Params = { params: Promise<{ teamId: string }> };

const querySchema = z.string().min(1).max(SEARCH_QUERY_MAX_LENGTH);

// GET /api/teams/[teamId]/members/search?q=<query> — Search tenant members to add
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const parsed = querySchema.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR },
      { status: 400 },
    );
  }

  // Escape LIKE wildcards to prevent full-table scans
  const query = parsed.data.replace(/[%_\\]/g, "\\$&");

  let results: { id: string; name: string | null; email: string | null; image: string | null }[];
  try {
    results = await withTeamTenantRls(teamId, async () => {
      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { tenantId: true },
      });
      if (!team) return [];

      // Get active team member userIds to exclude
      const activeMembers = await prisma.teamMember.findMany({
        where: { teamId, deactivatedAt: null },
        select: { userId: true },
      });
      const activeMemberIds = new Set(activeMembers.map((m) => m.userId));

      // Get non-expired pending invitation emails, then resolve to userIds
      const pendingInvitations = await prisma.teamInvitation.findMany({
        where: {
          teamId,
          status: INVITATION_STATUS.PENDING,
          expiresAt: { gt: new Date() },
        },
        select: { email: true },
      });
      const pendingEmails = pendingInvitations.map((inv) => inv.email);

      let pendingUserIds = new Set<string>();
      if (pendingEmails.length > 0) {
        const pendingUsers = await prisma.user.findMany({
          where: { email: { in: pendingEmails }, tenantId: team.tenantId },
          select: { id: true },
        });
        pendingUserIds = new Set(pendingUsers.map((u) => u.id));
      }

      // Combine exclusion set
      const excludeIds = [...activeMemberIds, ...pendingUserIds];

      // Search tenant members
      return prisma.user.findMany({
        where: {
          tenantId: team.tenantId,
          ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
          tenantMemberships: {
            some: { tenantId: team.tenantId, deactivatedAt: null },
          },
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
          ],
        },
        select: { id: true, name: true, email: true, image: true },
        take: 10,
        orderBy: { name: "asc" },
      });
    });
  } catch {
    // withTeamTenantRls throws if tenant cannot be resolved (e.g., team deleted between auth and RLS)
    results = [];
  }

  return NextResponse.json(
    results.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
    })),
  );
}

export const GET = withRequestLog(handleGET);
