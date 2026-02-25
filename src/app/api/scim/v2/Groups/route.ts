import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import type { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateScimToken } from "@/lib/scim-token";
import {
  scimResponse,
  scimError,
  scimListResponse,
  getScimBaseUrl,
} from "@/lib/scim/response";
import {
  roleToScimGroup,
  roleGroupId,
  type ScimGroupMemberInput,
} from "@/lib/scim/serializers";
import { scimGroupSchema } from "@/lib/scim/validations";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_ROLE } from "@/lib/constants";

/** Non-OWNER roles exposed as SCIM Groups. */
const SCIM_GROUP_ROLES: OrgRole[] = [
  ORG_ROLE.ADMIN,
  ORG_ROLE.MEMBER,
  ORG_ROLE.VIEWER,
];

// GET /api/scim/v2/Groups — List all role-based groups
export async function GET(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { orgId } = result.data;

  if (!(await checkScimRateLimit(orgId))) {
    return scimError(429, "Too many requests");
  }

  const baseUrl = getScimBaseUrl();

  // Fetch all active members grouped by role
  const members = await prisma.orgMember.findMany({
    where: { orgId, deactivatedAt: null },
    include: { user: { select: { id: true, email: true } } },
  });

  const membersByRole = new Map<OrgRole, ScimGroupMemberInput[]>();
  for (const role of SCIM_GROUP_ROLES) {
    membersByRole.set(role, []);
  }
  for (const m of members) {
    if (!m.user.email) continue;
    const list = membersByRole.get(m.role);
    if (list) {
      list.push({ userId: m.userId, email: m.user.email });
    }
  }

  const groups = SCIM_GROUP_ROLES.map((role) =>
    roleToScimGroup(orgId, role, membersByRole.get(role) ?? [], baseUrl),
  );

  // Support filter by displayName (only supported filter for Groups)
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
}

// POST /api/scim/v2/Groups — Register external mapping for a role group
export async function POST(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { orgId } = result.data;

  if (!(await checkScimRateLimit(orgId))) {
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

  // Validate displayName matches an existing role
  const matchedRole = SCIM_GROUP_ROLES.find(
    (r) => r.toLowerCase() === displayName.toLowerCase(),
  );
  if (!matchedRole) {
    return scimError(400, `Unknown group displayName. Valid names: ${SCIM_GROUP_ROLES.join(", ")}`);
  }

  const groupId = roleGroupId(orgId, matchedRole);

  // Register external mapping if externalId provided
  if (externalId) {
    const existingMapping = await prisma.scimExternalMapping.findUnique({
      where: {
        orgId_externalId_resourceType: { orgId, externalId, resourceType: "Group" },
      },
    });
    if (existingMapping && existingMapping.internalId !== groupId) {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    if (!existingMapping) {
      try {
        // Delete stale mapping for this group (handles externalId reassignment)
        await prisma.scimExternalMapping.deleteMany({
          where: { orgId, internalId: groupId, resourceType: "Group" },
        });
        await prisma.scimExternalMapping.create({
          data: { orgId, externalId, resourceType: "Group", internalId: groupId },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
        }
        throw e;
      }
    }
  }

  const baseUrl = getScimBaseUrl();

  // Fetch current members for this role
  const members = await prisma.orgMember.findMany({
    where: { orgId, role: matchedRole, deactivatedAt: null },
    include: { user: { select: { id: true, email: true } } },
  });

  const memberInputs: ScimGroupMemberInput[] = members
    .filter((m) => m.user.email != null)
    .map((m) => ({
      userId: m.userId,
      email: m.user.email!,
    }));

  const resource = roleToScimGroup(orgId, matchedRole, memberInputs, baseUrl);
  return scimResponse(resource, 201);
}
