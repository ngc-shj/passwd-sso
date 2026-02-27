import type { NextRequest } from "next/server";
import type { TeamRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateScimToken } from "@/lib/scim-token";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import type { ScimGroupMemberInput, ScimGroupResource } from "@/lib/scim/serializers";
import { scimPatchOpSchema, scimGroupSchema } from "@/lib/scim/validations";
import { parseGroupPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_ROLE, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";

type Params = { params: Promise<{ id: string }> };

function toDisplayName(teamSlug: string | null | undefined, role: TeamRole): string {
  return teamSlug ? `${teamSlug}:${role}` : role;
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

async function resolveGroupMapping(tenantId: string, scimId: string) {
  return prisma.scimGroupMapping.findUnique({
    where: {
      tenantId_externalGroupId: {
        tenantId,
        externalGroupId: scimId,
      },
    },
    select: {
      id: true,
      externalGroupId: true,
      role: true,
      teamId: true,
      team: { select: { slug: true } },
    },
  });
}

async function resolveActiveTenantMemberId(
  tx: Pick<typeof prisma, "tenantMember">,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const tenantMember = await tx.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { id: true, deactivatedAt: true },
  });
  if (!tenantMember || tenantMember.deactivatedAt !== null) {
    return null;
  }
  return tenantMember.id;
}

async function buildResourceFromMapping(
  mapping: {
    externalGroupId: string;
    role: TeamRole;
    teamId: string;
    team: { slug: string | null };
  },
  baseUrl: string,
) {
  const members = await prisma.teamMember.findMany({
    where: { teamId: mapping.teamId, role: mapping.role, deactivatedAt: null },
    include: { user: { select: { id: true, email: true } } },
  });
  const memberInputs: ScimGroupMemberInput[] = members
    .filter((m) => m.user.email != null)
    .map((m) => ({
      userId: m.userId,
      email: m.user.email!,
    }));
  return buildGroupResource(
    mapping.externalGroupId,
    toDisplayName(mapping.team.slug, mapping.role),
    memberInputs,
    baseUrl,
  );
}

// GET /api/scim/v2/Groups/[id]
export async function GET(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  return withTenantRls(prisma, tenantId, async () => {
    const { id } = await params;
    const mapping = await resolveGroupMapping(tenantId, id);
    if (!mapping) {
      return scimError(404, "Group not found");
    }

    const resource = await buildResourceFromMapping(mapping, getScimBaseUrl());
    return scimResponse(resource);
  });
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

  const { id } = await params;
  const resultResponse = await withTenantRls(prisma, tenantId, async () => {
    const mapping = await resolveGroupMapping(tenantId, id);
    if (!mapping) {
      return { error: scimError(404, "Group not found") };
    }

    const expectedDisplayName = toDisplayName(mapping.team.slug, mapping.role);
    if (parsed.data.displayName.toLowerCase() !== expectedDisplayName.toLowerCase()) {
      return { error: scimError(400, `displayName must be '${expectedDisplayName}'`) };
    }

    const requestedUserIds = new Set(parsed.data.members.map((m) => m.value));

    const currentMembers = await prisma.teamMember.findMany({
      where: { teamId: mapping.teamId, role: mapping.role, deactivatedAt: null },
      select: { id: true, userId: true, role: true },
    });
    const currentUserIds = new Set(currentMembers.map((m) => m.userId));

    const toAdd = [...requestedUserIds].filter((uid) => !currentUserIds.has(uid));
    const toRemove = currentMembers.filter((m) => !requestedUserIds.has(m.userId));

    if (mapping.role === TEAM_ROLE.OWNER) {
      return { error: scimError(403, API_ERROR.SCIM_OWNER_PROTECTED) };
    }

    try {
      await prisma.$transaction(async (tx) => {
        for (const userId of toAdd) {
          const member = await tx.teamMember.findUnique({
            where: { teamId_userId: { teamId: mapping.teamId, userId } },
            select: { id: true, role: true },
          });
          if (!member) {
            const tenantMemberId = await resolveActiveTenantMemberId(
              tx,
              tenantId,
              userId,
            );
            if (!tenantMemberId) {
              throw new Error(`SCIM_NO_SUCH_MEMBER:${userId}`);
            }
            await tx.teamMember.create({
              data: {
                teamId: mapping.teamId,
                userId,
                tenantId,
                role: mapping.role,
                scimManaged: true,
              },
            });
            continue;
          }
          if (member.role === TEAM_ROLE.OWNER) {
            throw new Error("SCIM_OWNER_PROTECTED");
          }
          await tx.teamMember.update({ where: { id: member.id }, data: { role: mapping.role } });
        }

        for (const m of toRemove) {
          const fresh = await tx.teamMember.findUnique({
            where: { id: m.id },
            select: { role: true },
          });
          if (fresh?.role === TEAM_ROLE.OWNER) {
            throw new Error("SCIM_OWNER_PROTECTED");
          }
          if (fresh?.role === mapping.role) {
            await tx.teamMember.update({
              where: { id: m.id },
              data: { role: TEAM_ROLE.MEMBER },
            });
          }
        }
      });
    } catch (e) {
      if (e instanceof Error) {
        if (e.message.startsWith("SCIM_NO_SUCH_MEMBER:")) {
          return { error: scimError(400, "Referenced member does not exist in this team") };
        }
        if (e.message === "SCIM_OWNER_PROTECTED") {
          return { error: scimError(403, API_ERROR.SCIM_OWNER_PROTECTED) };
        }
      }
      throw e;
    }

    const resource = await buildResourceFromMapping(mapping, getScimBaseUrl());
    return { resource, mapping, toAdd, toRemove };
  });
  if ("error" in resultResponse) {
    return resultResponse.error;
  }
  const { resource, mapping, toAdd, toRemove } = resultResponse;

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    userId: auditUserId,
    teamId: mapping.teamId ?? scopedTeamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: id,
    metadata: { role: mapping.role, added: toAdd.length, removed: toRemove.length },
    ...extractRequestMeta(req),
  });

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

  const { id } = await params;
  const resultResponse = await withTenantRls(prisma, tenantId, async () => {
    const mapping = await resolveGroupMapping(tenantId, id);
    if (!mapping) {
      return { error: scimError(404, "Group not found") };
    }

    try {
      await prisma.$transaction(async (tx) => {
        for (const action of actions) {
          const member = await tx.teamMember.findUnique({
            where: { teamId_userId: { teamId: mapping.teamId, userId: action.userId } },
            select: { id: true, role: true },
          });
          if (action.op === "add") {
            if (!member) {
              const tenantMemberId = await resolveActiveTenantMemberId(
                tx,
                tenantId,
                action.userId,
              );
              if (!tenantMemberId) {
                throw new Error(`SCIM_NO_SUCH_MEMBER:${action.userId}`);
              }
              await tx.teamMember.create({
                data: {
                  teamId: mapping.teamId,
                  userId: action.userId,
                  tenantId,
                  role: mapping.role,
                  scimManaged: true,
                },
              });
              continue;
            }
            if (member.role === TEAM_ROLE.OWNER) {
              throw new Error("SCIM_OWNER_PROTECTED");
            }
            await tx.teamMember.update({ where: { id: member.id }, data: { role: mapping.role } });
          } else if (action.op === "remove") {
            if (!member) {
              throw new Error(`SCIM_NO_SUCH_MEMBER:${action.userId}`);
            }
            if (member.role === TEAM_ROLE.OWNER) {
              throw new Error("SCIM_OWNER_PROTECTED");
            }
            if (member.role === mapping.role) {
              await tx.teamMember.update({ where: { id: member.id }, data: { role: TEAM_ROLE.MEMBER } });
            }
          }
        }
      });
    } catch (e) {
      if (e instanceof Error) {
        if (e.message.startsWith("SCIM_NO_SUCH_MEMBER:")) {
          return { error: scimError(400, "Referenced member does not exist in this team") };
        }
        if (e.message === "SCIM_OWNER_PROTECTED") {
          return { error: scimError(403, API_ERROR.SCIM_OWNER_PROTECTED) };
        }
      }
      throw e;
    }

    const resource = await buildResourceFromMapping(mapping, getScimBaseUrl());
    return { resource, mapping };
  });
  if ("error" in resultResponse) {
    return resultResponse.error;
  }
  const { resource, mapping } = resultResponse;

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    userId: auditUserId,
    teamId: mapping.teamId ?? scopedTeamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: id,
    metadata: {
      role: mapping.role,
      operations: actions.map((a) => ({ op: a.op, userId: a.userId })),
    },
    ...extractRequestMeta(req),
  });

  return scimResponse(resource);
}

// DELETE /api/scim/v2/Groups/[id] — Not allowed
export async function DELETE(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }

  const { tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  await params;

  return scimError(405, "Role-based groups cannot be deleted");
}
