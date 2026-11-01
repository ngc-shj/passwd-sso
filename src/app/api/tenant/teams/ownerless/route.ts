import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { TEAM_ROLE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";
import { buildTeamMemberDisplayItems } from "@/lib/team/team-member-display";

// GET /api/tenant/teams/ownerless — Teams of the actor's tenant with no active
// OWNER (the owner left the tenant), with the members who could be assigned one:
// active in the team and in this tenant, the set the owner route accepts. Tenant admins are not necessarily members of these teams, so
// the team pages that list members are not open to them.
async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.TEAM_OWNER_ASSIGN);
  } catch (e) {
    return handleAuthError(e);
  }

  const { teams, activeHere } = await withTenantRls(prisma, actor.tenantId, async (tx) => {
    const teams = await tx.team.findMany({
      where: {
        tenantId: actor.tenantId,
        members: { none: { role: TEAM_ROLE.OWNER, deactivatedAt: null } },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        members: {
          where: { deactivatedAt: null },
          select: { id: true, userId: true, role: true, createdAt: true },
          orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        },
      },
      orderBy: { name: "asc" },
    });
    // A candidate must be an active member of THIS tenant: the owner route
    // refuses anyone else (a guest from another tenant has no row here).
    const userIds = [...new Set(teams.flatMap((team) => team.members.map((m) => m.userId)))];
    const rows = await tx.tenantMember.findMany({
      where: { tenantId: actor.tenantId, userId: { in: userIds }, deactivatedAt: null },
      select: { userId: true },
    });
    return { teams, activeHere: new Set(rows.map((r) => r.userId)) };
  });

  const result = await Promise.all(
    teams.map(async (team) => ({
      id: team.id,
      name: team.name,
      slug: team.slug,
      members: (await buildTeamMemberDisplayItems(team.members.filter((m) => activeHere.has(m.userId)))).map((m) => ({
        userId: m.userId,
        role: m.role,
        name: m.name,
        email: m.email,
      })),
    })),
  );

  return NextResponse.json({ teams: result });
}

export const GET = withRequestLog(handleGET);
