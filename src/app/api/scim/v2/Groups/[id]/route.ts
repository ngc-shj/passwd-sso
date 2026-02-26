import type { NextRequest } from "next/server";
import type { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateScimToken } from "@/lib/scim-token";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import {
  roleToScimGroup,
  roleGroupId,
  type ScimGroupMemberInput,
} from "@/lib/scim/serializers";
import { scimPatchOpSchema, scimGroupSchema } from "@/lib/scim/validations";
import { parseGroupPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_ROLE, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

type Params = { params: Promise<{ id: string }> };

const SCIM_GROUP_ROLES: OrgRole[] = [
  TEAM_ROLE.ADMIN,
  TEAM_ROLE.MEMBER,
  TEAM_ROLE.VIEWER,
];

/** Resolve a SCIM Group ID back to (teamId, role). Falls back to ScimExternalMapping. */
async function resolveGroupRole(
  teamId: string,
  tenantId: string,
  scimId: string,
): Promise<OrgRole | null> {
  // First try computed group IDs
  for (const role of SCIM_GROUP_ROLES) {
    if (roleGroupId(teamId, role) === scimId) return role;
  }

  // Fallback: resolve via ScimExternalMapping (IdP may use externalId as the group id)
  const mapping = await prisma.scimExternalMapping.findFirst({
    where: {
      tenantId,
      externalId: scimId,
      resourceType: "Group",
    },
    select: { internalId: true },
  });
  if (mapping) {
    for (const role of SCIM_GROUP_ROLES) {
      if (roleGroupId(teamId, role) === mapping.internalId) return role;
    }
  }

  return null;
}

async function buildGroupResource(
  teamId: string,
  role: OrgRole,
  baseUrl: string,
) {
  const members = await prisma.orgMember.findMany({
    where: { orgId: teamId, role, deactivatedAt: null },
    include: { user: { select: { id: true, email: true } } },
  });
  const memberInputs: ScimGroupMemberInput[] = members
    .filter((m) => m.user.email != null)
    .map((m) => ({
      userId: m.userId,
      email: m.user.email!,
    }));
  return roleToScimGroup(teamId, role, memberInputs, baseUrl);
}

// GET /api/scim/v2/Groups/[id]
export async function GET(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { teamId: scopedTeamId, tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const { id } = await params;
  const role = await resolveGroupRole(scopedTeamId, tenantId, id);
  if (!role) {
    return scimError(404, "Group not found");
  }

  const baseUrl = getScimBaseUrl();
  const resource = await buildGroupResource(scopedTeamId, role, baseUrl);
  return scimResponse(resource);
}

// PUT /api/scim/v2/Groups/[id] — Full member replacement
export async function PUT(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { teamId: scopedTeamId, tenantId, auditUserId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const { id } = await params;
  const role = await resolveGroupRole(scopedTeamId, tenantId, id);
  if (!role) {
    return scimError(404, "Group not found");
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

  const requestedUserIds = new Set(parsed.data.members.map((m) => m.value));

  // Get current members in this role
  const currentMembers = await prisma.orgMember.findMany({
    where: { orgId: scopedTeamId, role, deactivatedAt: null },
    select: { id: true, userId: true, role: true },
  });
  const currentUserIds = new Set(currentMembers.map((m) => m.userId));

  // Members to add to this role
  const toAdd = [...requestedUserIds].filter((uid) => !currentUserIds.has(uid));
  // Members to remove from this role (will become MEMBER)
  const toRemove = currentMembers.filter((m) => !requestedUserIds.has(m.userId));

  // Block adding members to OWNER role (OWNER role is not a SCIM group, but guard anyway)
  // Note: SCIM_GROUP_ROLES excludes OWNER, so this shouldn't happen, but defensive check
  if (role === TEAM_ROLE.OWNER) {
    return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
  }

  // Apply changes atomically — all OWNER checks inside tx to avoid TOCTOU
  try {
    await prisma.$transaction(async (tx) => {
      for (const userId of toAdd) {
        const member = await tx.orgMember.findUnique({
          where: { orgId_userId: { orgId: scopedTeamId, userId } },
          select: { id: true, role: true },
        });
        if (!member) {
          throw new Error(`SCIM_NO_SUCH_MEMBER:${userId}`);
        }
        if (member.role === TEAM_ROLE.OWNER) {
          throw new Error("SCIM_OWNER_PROTECTED");
        }
        await tx.orgMember.update({
          where: { id: member.id },
          data: { role },
        });
      }

      for (const m of toRemove) {
        // Re-check role inside tx to avoid TOCTOU
        const fresh = await tx.orgMember.findUnique({
          where: { id: m.id },
          select: { role: true },
        });
        if (fresh?.role === TEAM_ROLE.OWNER) {
          throw new Error("SCIM_OWNER_PROTECTED");
        }
        // Only demote if member is still in the target role (avoids overwriting concurrent changes)
        if (fresh?.role === role) {
          await tx.orgMember.update({
            where: { id: m.id },
            data: { role: TEAM_ROLE.MEMBER },
          });
        }
      }
    });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message.startsWith("SCIM_NO_SUCH_MEMBER:")) {
        return scimError(400, "Referenced member does not exist in this team");
      }
      if (e.message === "SCIM_OWNER_PROTECTED") {
        return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
      }
    }
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    userId: auditUserId,
    orgId: scopedTeamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: id,
    metadata: { role, added: toAdd.length, removed: toRemove.length },
    ...extractRequestMeta(req),
  });

  const baseUrl = getScimBaseUrl();
  const resource = await buildGroupResource(scopedTeamId, role, baseUrl);
  return scimResponse(resource);
}

// PATCH /api/scim/v2/Groups/[id] — Add/remove members
export async function PATCH(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { teamId: scopedTeamId, tenantId, auditUserId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const { id } = await params;
  const role = await resolveGroupRole(scopedTeamId, tenantId, id);
  if (!role) {
    return scimError(404, "Group not found");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON");
  }

  const parsed = scimPatchOpSchema.safeParse(body);
  if (!parsed.success) {
    return scimError(400, parsed.error.issues.map((i) => i.message).join("; "));
  }

  let actions;
  try {
    actions = parseGroupPatchOps(parsed.data.Operations);
  } catch (e) {
    if (e instanceof PatchParseError) {
      return scimError(400, e.message);
    }
    throw e;
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const action of actions) {
        const member = await tx.orgMember.findUnique({
          where: { orgId_userId: { orgId: scopedTeamId, userId: action.userId } },
          select: { id: true, role: true },
        });
        if (!member) {
          throw new Error(`SCIM_NO_SUCH_MEMBER:${action.userId}`);
        }

        // OWNER protection
        if (member.role === TEAM_ROLE.OWNER) {
          throw new Error("SCIM_OWNER_PROTECTED");
        }

        if (action.op === "add") {
          await tx.orgMember.update({
            where: { id: member.id },
            data: { role },
          });
        } else if (action.op === "remove") {
          // When removed from a group, default to MEMBER
          if (member.role === role) {
            await tx.orgMember.update({
              where: { id: member.id },
              data: { role: TEAM_ROLE.MEMBER },
            });
          }
        }
      }
    });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message.startsWith("SCIM_NO_SUCH_MEMBER:")) {
        return scimError(400, "Referenced member does not exist in this team");
      }
      if (e.message === "SCIM_OWNER_PROTECTED") {
        return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
      }
    }
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    userId: auditUserId,
    orgId: scopedTeamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: id,
    metadata: {
      role,
      operations: actions.map((a) => ({ op: a.op, userId: a.userId })),
    },
    ...extractRequestMeta(req),
  });

  const baseUrl = getScimBaseUrl();
  const resource = await buildGroupResource(scopedTeamId, role, baseUrl);
  return scimResponse(resource);
}

// DELETE /api/scim/v2/Groups/[id] — Not allowed (role-based groups cannot be deleted)
export async function DELETE(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }

  const { tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  // Consume params to avoid Next.js warning
  await params;

  return scimError(405, "Role-based groups cannot be deleted");
}
