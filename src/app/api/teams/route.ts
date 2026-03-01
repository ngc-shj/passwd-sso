import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTeamE2ESchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_ROLE } from "@/lib/constants";
import { resolveUserTenantId, resolveUserTenantIdFromClient, withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { getLogger } from "@/lib/logger";

// GET /api/teams — List teams the user belongs to
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { userTenantId, memberships } = await withBypassRls(prisma, async () => {
    const uid = await resolveUserTenantIdFromClient(prisma, session.user.id);
    const data = await prisma.teamMember.findMany({
      where: { userId: session.user.id, deactivatedAt: null },
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
      { userId: session.user.id, crossTenantTeamIds: crossTenantTeams.map((t) => t.id) },
      "Cross-tenant team memberships detected",
    );
  }

  return NextResponse.json(teams);
}

// POST /api/teams — Create a new E2E-enabled team
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = createTeamE2ESchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { id: clientId, name, slug, description, teamMemberKey } = parsed.data;

  let tenantId: string;
  try {
    tenantId = await resolveUserTenantId(session.user.id) ?? "";
  } catch (e) {
    if (e instanceof Error && e.message === "MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED") {
      return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
    }
    throw e;
  }
  if (!tenantId) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  // Check slug uniqueness in tenant context
  let existing;
  try {
    existing = await withUserTenantRls(session.user.id, async () =>
      prisma.team.findUnique({
        where: { slug },
        select: { id: true },
      }),
    );
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message === "TENANT_NOT_RESOLVED" ||
        e.message === "MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED")
    ) {
      return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
    }
    throw e;
  }
  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.SLUG_ALREADY_TAKEN },
      { status: 409 },
    );
  }

  let team;
  try {
    team = await withUserTenantRls(session.user.id, async () =>
      prisma.team.create({
        data: {
          ...(clientId ? { id: clientId } : {}),
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
      return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: API_ERROR.SLUG_ALREADY_TAKEN },
        { status: 409 }
      );
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
