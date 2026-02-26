import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTeamE2ESchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_ROLE } from "@/lib/constants";

// GET /api/teams — List organizations the user belongs to
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const memberships = await prisma.orgMember.findMany({
    where: { userId: session.user.id, deactivatedAt: null },
    include: {
      org: {
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          createdAt: true,
        },
      },
    },
    orderBy: { org: { name: "asc" } },
  });

  const orgs = memberships.map((m) => ({
    ...m.org,
    role: m.role,
  }));

  return NextResponse.json(orgs);
}

// POST /api/teams — Create a new E2E-enabled organization
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

  // Check slug uniqueness
  const existing = await prisma.organization.findUnique({
    where: { slug },
  });
  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.SLUG_ALREADY_TAKEN },
      { status: 409 }
    );
  }

  const team = await prisma.organization.create({
    data: {
      ...(clientId ? { id: clientId } : {}),
      tenant: {
        create: {
          name,
          slug: `tenant-${slug}`,
          description: description || null,
        },
      },
      name,
      slug,
      description: description || null,
      orgKeyVersion: 1,
      members: {
        create: {
          userId: session.user.id,
          role: TEAM_ROLE.OWNER,
          keyDistributed: true,
        },
      },
      memberKeys: {
        create: {
          userId: session.user.id,
          encryptedOrgKey: teamMemberKey.encryptedOrgKey,
          orgKeyIv: teamMemberKey.teamKeyIv,
          orgKeyAuthTag: teamMemberKey.teamKeyAuthTag,
          ephemeralPublicKey: teamMemberKey.ephemeralPublicKey,
          hkdfSalt: teamMemberKey.hkdfSalt,
          keyVersion: teamMemberKey.keyVersion,
          wrapVersion: teamMemberKey.wrapVersion,
        },
      },
    },
  });

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
