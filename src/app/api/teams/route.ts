import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { authOrToken } from "@/lib/auth-or-token";
import { createTeamE2ESchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, forbidden } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { TEAM_ROLE, EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { resolveUserTenantIdFromClient, withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { getLogger } from "@/lib/logger";
import { withRequestLog } from "@/lib/with-request-log";

// GET /api/teams — List teams the user belongs to
async function handleGET(req: NextRequest) {
  const authResult = await authOrToken(req, EXTENSION_TOKEN_SCOPE.PASSWORDS_READ);
  if (!authResult || authResult.type === "scope_insufficient" || authResult.type === "service_account") {
    return unauthorized();
  }
  const userId = authResult.userId;

  const { userTenantId, memberships } = await withBypassRls(prisma, async () => {
    const uid = await resolveUserTenantIdFromClient(prisma, userId);
    const data = await prisma.teamMember.findMany({
      where: { userId, deactivatedAt: null },
      include: {
        team: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            createdAt: true,
            _count: {
              select: { members: true },
            },
            tenant: {
              select: { id: true, name: true },
            },
          },
        },
      },
      orderBy: { team: { name: "asc" } },
    });
    return { userTenantId: uid, memberships: data };
  });

  const teams = memberships.map((m) => ({
    id: m.team.id,
    name: m.team.name,
    slug: m.team.slug,
    description: m.team.description,
    createdAt: m.team.createdAt,
    role: m.role,
    memberCount: m.team._count.members,
    tenantName: m.team.tenant.name,
    isCrossTenant: userTenantId !== m.team.tenant.id,
  }));

  const logger = getLogger();
  const crossTenantTeams = teams.filter((t) => t.isCrossTenant);
  if (crossTenantTeams.length > 0) {
    logger.info(
      { userId, crossTenantTeamIds: crossTenantTeams.map((t) => t.id) },
      "Cross-tenant team memberships detected",
    );
  }

  return NextResponse.json(teams);
}

// POST /api/teams — Create a new E2E-enabled team
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  // Only OWNER / ADMIN can create teams
  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.TEAM_CREATE);
  } catch (e) {
    if (e instanceof TenantAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }
  const tenantId = actor.tenantId;

  const result = await parseBody(req, createTeamE2ESchema);
  if (!result.ok) return result.response;
  const { id: clientId, name, slug, description, teamMemberKey } = result.data;

  // Check slug uniqueness within the tenant
  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.team.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
      select: { id: true },
    }),
  );
  if (existing) {
    return errorResponse(API_ERROR.SLUG_ALREADY_TAKEN, 409);
  }

  let team;
  try {
    team = await withUserTenantRls(session.user.id, async () =>
      prisma.team.create({
        data: {
          id: clientId,
          tenant: { connect: { id: tenantId } },
          name,
          slug,
          description: description || null,
          teamKeyVersion: 1,
          members: {
            create: {
              userId: session.user.id,
              tenantId,
              role: TEAM_ROLE.OWNER,
              keyDistributed: true,
            },
          },
          memberKeys: {
            create: {
              userId: session.user.id,
              tenantId,
              encryptedTeamKey: teamMemberKey.encryptedTeamKey,
              teamKeyIv: teamMemberKey.teamKeyIv,
              teamKeyAuthTag: teamMemberKey.teamKeyAuthTag,
              ephemeralPublicKey: teamMemberKey.ephemeralPublicKey,
              hkdfSalt: teamMemberKey.hkdfSalt,
              keyVersion: teamMemberKey.keyVersion,
              wrapVersion: teamMemberKey.wrapVersion,
            },
          },
        },
      }),
    );
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message === "TENANT_NOT_RESOLVED" ||
        e.message === "MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED")
    ) {
      return forbidden();
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return errorResponse(API_ERROR.SLUG_ALREADY_TAKEN, 409);
    }
    throw e;
  }

  return NextResponse.json(
    {
      id: team.id,
      name: team.name,
      slug: team.slug,
      description: team.description,
      role: TEAM_ROLE.OWNER,
      createdAt: team.createdAt,
    },
    { status: 201 }
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
