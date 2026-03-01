import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/members — List members
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const members = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findMany({
      where: { teamId: teamId, deactivatedAt: null },
      include: {
        user: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    }),
  );

  // Batch-fetch each member's own tenant name (cross-tenant: user's tenant ≠ team's tenant)
  // userIds are constrained to this team's members from the withTeamTenantRls query above.
  // System enforces single tenant per user; if multiple TenantMember records exist, last wins.
  const userIds = members.map((m) => m.userId);
  const userTenants = await withBypassRls(prisma, async () =>
    prisma.tenantMember.findMany({
      where: { userId: { in: userIds }, deactivatedAt: null },
      select: { userId: true, tenant: { select: { name: true } } },
    }),
  );
  const tenantByUserId = new Map(userTenants.map((t) => [t.userId, t.tenant.name]));

  return NextResponse.json(
    members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
      joinedAt: m.createdAt,
      tenantName: tenantByUserId.get(m.userId) ?? null,
    }))
  );
}
