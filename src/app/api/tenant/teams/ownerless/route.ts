import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { TEAM_ROLE, TENANT_ROLE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { actorDepartedSinceAdmission, readTenantRows } from "@/lib/team/tenant-row-lock";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";
import { buildTeamMemberDisplayItems } from "@/lib/team/team-member-display";

// GET /api/tenant/teams/ownerless — Teams of the actor's tenant with no active
// OWNER (the owner left the tenant, or remains only as a leftover membership),
// with the members who could be assigned one:
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

  const { teams, tenantRows } = await withTenantRls(prisma, actor.tenantId, async (tx) => {
    // Candidates: teams with no active OWNER whose user has never left this
    // tenant. A leftover OWNER (tenant row departed at or after their team
    // admission) counts as absent, which needs a departure stamp — a
    // deactivated tenant row or a departure record; the exact comparison with
    // the admission is made below on these teams only. The stamped users are
    // read first, not filtered through the User relation, which a tenant
    // context hides for a user filed under another tenant.
    const deactivated = await tx.tenantMember.findMany({
      where: { tenantId: actor.tenantId, deactivatedAt: { not: null } },
      select: { userId: true },
    });
    const departures = await tx.tenantMemberDeparture.findMany({
      where: { tenantId: actor.tenantId },
      select: { userId: true },
    });
    const stamped = [...new Set([...deactivated, ...departures].map((r) => r.userId))];
    const teams = await tx.team.findMany({
      where: {
        tenantId: actor.tenantId,
        members: {
          none: { role: TEAM_ROLE.OWNER, deactivatedAt: null, userId: { notIn: stamped } },
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        members: {
          where: { deactivatedAt: null },
          select: { id: true, userId: true, role: true, admittedAt: true, createdAt: true },
          orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        },
      },
      orderBy: { name: "asc" },
    });
    const userIds = [...new Set(teams.flatMap((team) => team.members.map((m) => m.userId)))];
    return { teams, tenantRows: await readTenantRows(tx, actor.tenantId, userIds) };
  });

  type Member = (typeof teams)[number]["members"][number];
  const isLeftover = (m: Member) => actorDepartedSinceAdmission(tenantRows.get(m.userId), m.admittedAt ?? m.createdAt);
  // A candidate must be an active member of THIS tenant and not a leftover:
  // the owner route refuses anyone else (a guest from another tenant has no
  // row here).
  const isCandidate = (m: Member) => {
    const row = tenantRows.get(m.userId);
    return row?.hasRow === true && row.deactivatedAt === null && !isLeftover(m);
  };
  const ownerless = teams.filter((team) => !team.members.some((m) => m.role === TEAM_ROLE.OWNER && !isLeftover(m)));

  // The owner route refuses self-assignment unless the actor is tenant OWNER.
  const selfExcluded = actor.role !== TENANT_ROLE.OWNER;
  const result = await Promise.all(
    ownerless.map(async (team) => ({
      id: team.id,
      name: team.name,
      slug: team.slug,
      members: (await buildTeamMemberDisplayItems(team.members.filter((m) => isCandidate(m) && !(selfExcluded && m.userId === session.user.id)))).map((m) => ({
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
