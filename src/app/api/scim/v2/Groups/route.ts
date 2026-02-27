import type { NextRequest } from "next/server";
import type { TeamRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateScimToken } from "@/lib/scim-token";
import {
  scimResponse,
  scimError,
  scimListResponse,
  getScimBaseUrl,
} from "@/lib/scim/response";
import type { ScimGroupMemberInput, ScimGroupResource } from "@/lib/scim/serializers";
import { scimGroupSchema } from "@/lib/scim/validations";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_ROLE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";

const SCIM_GROUP_ROLES: TeamRole[] = [
  TEAM_ROLE.ADMIN,
  TEAM_ROLE.MEMBER,
  TEAM_ROLE.VIEWER,
];

function toDisplayName(teamSlug: string | null | undefined, role: TeamRole): string {
  return teamSlug ? `${teamSlug}:${role}` : role;
}

function parseRoleFromDisplayName(displayName: string, expectedTeamSlug: string | null | undefined): TeamRole | null {
  if (!expectedTeamSlug) return null;
  const separator = displayName.indexOf(":");
  if (separator < 1) return null;
  const slugPart = displayName.slice(0, separator).trim();
  const rolePart = displayName.slice(separator + 1).trim();
  if (slugPart !== expectedTeamSlug) return null;
  const matchedRole = SCIM_GROUP_ROLES.find((r) => r.toLowerCase() === rolePart.toLowerCase());
  return matchedRole ?? null;
}

function buildGroupResource(
  externalGroupId: string,
  displayName: string,
  members: ScimGroupMemberInput[],
  baseUrl: string,
): ScimGroupResource {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id: externalGroupId,
    displayName,
    members: members.map((m) => ({
      value: m.userId,
      display: m.email,
      $ref: `${baseUrl}/Users/${m.userId}`,
    })),
    meta: {
      resourceType: "Group",
      location: `${baseUrl}/Groups/${externalGroupId}`,
    },
  };
}

async function loadGroupMembers(teamId: string, role: TeamRole): Promise<ScimGroupMemberInput[]> {
  const members = await prisma.teamMember.findMany({
    where: { teamId, role, deactivatedAt: null },
    include: { user: { select: { id: true, email: true } } },
  });

  return members
    .filter((m) => m.user.email != null)
    .map((m) => ({ userId: m.userId, email: m.user.email! }));
}

// GET /api/scim/v2/Groups — List all tenant mappings
export async function GET(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  return withTenantRls(prisma, tenantId, async () => {
    const baseUrl = getScimBaseUrl();

    const mappings = await prisma.scimGroupMapping.findMany({
      where: { tenantId },
      select: {
        externalGroupId: true,
        role: true,
        teamId: true,
        team: { select: { slug: true } },
      },
      orderBy: [{ createdAt: "asc" }],
    });

    const groups = await Promise.all(
      mappings.map(async (mapping) => {
        const members = await loadGroupMembers(mapping.teamId, mapping.role);
        return buildGroupResource(
          mapping.externalGroupId,
          toDisplayName(mapping.team.slug, mapping.role),
          members,
          baseUrl,
        );
      }),
    );

    const filterParam = req.nextUrl.searchParams.get("filter");
    if (filterParam) {
      if (filterParam.length > 256) {
        return scimError(400, "Filter exceeds maximum length of 256 characters");
      }
      const match = filterParam.match(/displayName\s+eq\s+"([^"]+)"/i);
      if (!match) {
        return scimError(400, "Only 'displayName eq' filter is supported for Groups");
      }
      const filtered = groups.filter(
        (g) => g.displayName.toLowerCase() === match[1].toLowerCase(),
      );
      return scimListResponse(filtered, filtered.length);
    }

    return scimListResponse(groups, groups.length);
  });
}

// POST /api/scim/v2/Groups — Register tenant group mapping
export async function POST(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { teamId: scopedTeamId, tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON");
  }

  const parsed = scimGroupSchema.safeParse(body);
  if (!parsed.success) {
    return scimError(400, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { displayName, externalId } = parsed.data;

  if (!externalId || externalId.trim().length === 0) {
    return scimError(400, "externalId is required for tenant group mapping");
  }

  return withTenantRls(prisma, tenantId, async () => {
    const team = await prisma.team.findUnique({
      where: { id: scopedTeamId },
      select: { slug: true },
    });
    const matchedRole = parseRoleFromDisplayName(displayName, team?.slug);
    if (!matchedRole) {
      return scimError(400, "displayName must be in the format '<teamSlug>:<ROLE>' for the scoped team");
    }

    const existing = await prisma.scimGroupMapping.findUnique({
      where: {
        tenantId_externalGroupId: {
          tenantId,
          externalGroupId: externalId,
        },
      },
      select: {
        id: true,
        teamId: true,
        role: true,
      },
    });

    if (existing && (existing.teamId !== scopedTeamId || existing.role !== matchedRole)) {
      return scimError(409, "externalId is already mapped to a different group", "uniqueness");
    }

    if (!existing) {
      await prisma.scimGroupMapping.create({
        data: {
          tenantId,
          teamId: scopedTeamId,
          externalGroupId: externalId,
          role: matchedRole,
        },
      });
    }

    const members = await loadGroupMembers(scopedTeamId, matchedRole);

    return scimResponse(
      buildGroupResource(
        externalId,
        toDisplayName(team?.slug, matchedRole),
        members,
        getScimBaseUrl(),
      ),
      201,
    );
  });
}
