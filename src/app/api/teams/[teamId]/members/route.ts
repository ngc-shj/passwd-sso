import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { addMemberSchema } from "@/lib/validations";
import { requireTeamMember, requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
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

// POST /api/teams/[teamId]/members — Direct-add a tenant member
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE);
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

  const parsed = addMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { userId, role } = parsed.data;

  // Cannot add yourself
  if (userId === session.user.id) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  type MemberResult = {
    id: string;
    userId: string;
    role: string;
    reactivated: boolean;
  };

  let member: MemberResult;

  try {
    member = await withTeamTenantRls(teamId, async () => {
      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { tenantId: true },
      });
      if (!team) {
        throw new TeamAuthError(API_ERROR.NOT_FOUND, 404);
      }

      // Verify target user is an active tenant member
      const targetUser = await prisma.user.findFirst({
        where: { id: userId, tenantId: team.tenantId },
        select: { id: true },
      });
      if (!targetUser) {
        throw new TeamAuthError(API_ERROR.NOT_FOUND, 404);
      }

      const tenantMembership = await prisma.tenantMember.findFirst({
        where: { tenantId: team.tenantId, userId, deactivatedAt: null },
      });
      if (!tenantMembership) {
        throw new TeamAuthError(API_ERROR.NOT_FOUND, 404);
      }

      // Check existing TeamMember record
      const existing = await prisma.teamMember.findFirst({
        where: { teamId, userId },
      });

      if (existing) {
        if (existing.deactivatedAt === null) {
          throw new AlreadyMemberError();
        }
        if (existing.scimManaged) {
          throw new ScimManagedError();
        }

        // Reactivate: delete stale keys + update member
        const [, updated] = await prisma.$transaction([
          prisma.teamMemberKey.deleteMany({ where: { teamId, userId } }),
          prisma.teamMember.update({
            where: { id: existing.id },
            data: {
              deactivatedAt: null,
              role,
              keyDistributed: false,
              scimManaged: false,
            },
          }),
        ]);
        return { id: updated.id, userId: updated.userId, role: updated.role, reactivated: true };
      }

      // Create new TeamMember
      const created = await prisma.teamMember.create({
        data: {
          teamId,
          userId,
          tenantId: team.tenantId,
          role,
          keyDistributed: false,
        },
      });
      return { id: created.id, userId: created.userId, role: created.role, reactivated: false };
    });
  } catch (e) {
    if (e instanceof AlreadyMemberError) {
      return NextResponse.json({ error: API_ERROR.ALREADY_A_MEMBER }, { status: 409 });
    }
    if (e instanceof ScimManagedError) {
      return NextResponse.json({ error: API_ERROR.SCIM_MANAGED_MEMBER }, { status: 409 });
    }
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    // Prisma unique constraint violation (race condition)
    if (isPrismaUniqueConstraintError(e)) {
      return NextResponse.json({ error: API_ERROR.ALREADY_A_MEMBER }, { status: 409 });
    }
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.TEAM_MEMBER_ADD,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: member.id,
    metadata: { userId, role, reactivated: member.reactivated },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(member, { status: 201 });
}

class AlreadyMemberError extends Error {
  constructor() { super("ALREADY_A_MEMBER"); }
}

class ScimManagedError extends Error {
  constructor() { super("SCIM_MANAGED_MEMBER"); }
}

function isPrismaUniqueConstraintError(e: unknown): boolean {
  if (
    typeof e !== "object" ||
    e === null ||
    !("code" in e) ||
    (e as { code: string }).code !== "P2002"
  ) {
    return false;
  }
  // Verify it's the teamId+userId constraint, not an unrelated one
  const meta = "meta" in e ? (e as { meta?: { target?: unknown } }).meta : undefined;
  if (Array.isArray(meta?.target)) {
    return meta.target.includes("teamId") && meta.target.includes("userId");
  }
  return false; // Unknown constraint or non-array target — let the caller re-throw
}
