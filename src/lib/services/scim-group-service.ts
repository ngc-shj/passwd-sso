/**
 * SCIM Group service — Prisma queries and data transformation for SCIM Group operations.
 *
 * All functions must be called within a `withTenantRls()` context.
 */

import { prisma } from "@/lib/prisma";
import type { TeamRole } from "@prisma/client";
import type { ScimGroupMemberInput, ScimGroupResource } from "@/lib/scim/serializers";
import type { GroupMemberAction } from "@/lib/scim/patch-parser";
import { TEAM_ROLE } from "@/lib/constants";

// ── Input types ───────────────────────────────────────────────

export interface ScimGroupReplaceInput {
  /**
   * displayName from the PUT body — validated against the group's expected
   * `<teamSlug>:<role>` value. Case-insensitive comparison.
   */
  displayName: string;
  /** Members listed in the PUT body (resolved userId values). */
  memberUserIds: string[];
}

// ── Result types ──────────────────────────────────────────────

export interface ScimGroupReplaceResult {
  resource: ScimGroupResource;
  teamId: string;
  role: TeamRole;
  added: number;
  removed: number;
}

export interface ScimGroupPatchResult {
  resource: ScimGroupResource;
  teamId: string;
  role: TeamRole;
}

// ── Error classes ─────────────────────────────────────────────

export class ScimGroupNotFoundError extends Error {
  constructor() {
    super("Group not found");
    this.name = "ScimGroupNotFoundError";
  }
}

export class ScimOwnerProtectedError extends Error {
  constructor() {
    super("SCIM_OWNER_PROTECTED");
    this.name = "ScimOwnerProtectedError";
  }
}

export class ScimNoSuchMemberError extends Error {
  readonly userId: string;
  constructor(userId: string) {
    super(`SCIM_NO_SUCH_MEMBER:${userId}`);
    this.name = "ScimNoSuchMemberError";
    this.userId = userId;
  }
}

export class ScimDisplayNameMismatchError extends Error {
  readonly expectedDisplayName: string;
  constructor(expectedDisplayName: string) {
    super(`displayName must be '${expectedDisplayName}'`);
    this.name = "ScimDisplayNameMismatchError";
    this.expectedDisplayName = expectedDisplayName;
  }
}

// ── Internal helpers ──────────────────────────────────────────

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

async function loadGroupMembers(teamId: string, role: TeamRole): Promise<ScimGroupMemberInput[]> {
  const members = await prisma.teamMember.findMany({
    where: { teamId, role, deactivatedAt: null },
    include: { user: { select: { id: true, email: true } } },
  });
  return members
    .filter((m) => m.user.email != null)
    .map((m) => ({ userId: m.userId, email: m.user.email! }));
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

// ── Service functions ─────────────────────────────────────────

/**
 * Resolve a SCIM group `id` parameter to an internal teamId.
 *
 * Returns `null` if no ScimGroupMapping exists for the given tenant + SCIM group ID.
 */
export async function resolveGroupId(tenantId: string, scimId: string): Promise<string | null> {
  const mapping = await prisma.scimGroupMapping.findUnique({
    where: {
      tenantId_externalGroupId: {
        tenantId,
        externalGroupId: scimId,
      },
    },
    select: { teamId: true },
  });
  return mapping?.teamId ?? null;
}

/**
 * Fetch a SCIM Group resource by the SCIM external group ID.
 *
 * Returns `null` when no ScimGroupMapping is found for the given tenantId + scimId.
 */
export async function fetchScimGroup(
  tenantId: string,
  scimId: string,
  baseUrl: string,
): Promise<ScimGroupResource | null> {
  const mapping = await prisma.scimGroupMapping.findUnique({
    where: {
      tenantId_externalGroupId: {
        tenantId,
        externalGroupId: scimId,
      },
    },
    select: {
      externalGroupId: true,
      role: true,
      teamId: true,
      team: { select: { slug: true } },
    },
  });
  if (!mapping) return null;

  const members = await loadGroupMembers(mapping.teamId, mapping.role);
  return buildGroupResource(
    mapping.externalGroupId,
    toDisplayName(mapping.team.slug, mapping.role),
    members,
    baseUrl,
  );
}

/**
 * Full-replace a SCIM Group's member list (PUT semantics).
 *
 * Computes add/remove deltas against the current role membership, then applies
 * them in a single transaction. Owner-role groups and OWNER-role members are
 * always protected from modification.
 *
 * Throws:
 * - `ScimGroupNotFoundError` — no mapping found for tenantId + scimId
 * - `ScimOwnerProtectedError` — attempted to modify an OWNER-role group or an OWNER member
 * - `ScimNoSuchMemberError` — a referenced userId is not an active tenant member
 */
export async function replaceScimGroup(
  tenantId: string,
  scimId: string,
  data: ScimGroupReplaceInput,
  baseUrl: string,
): Promise<ScimGroupReplaceResult> {
  const mapping = await prisma.scimGroupMapping.findUnique({
    where: {
      tenantId_externalGroupId: {
        tenantId,
        externalGroupId: scimId,
      },
    },
    select: {
      externalGroupId: true,
      role: true,
      teamId: true,
      team: { select: { slug: true } },
    },
  });
  if (!mapping) throw new ScimGroupNotFoundError();

  const expectedDisplayName = toDisplayName(mapping.team.slug, mapping.role);
  if (data.displayName.toLowerCase() !== expectedDisplayName.toLowerCase()) {
    throw new ScimDisplayNameMismatchError(expectedDisplayName);
  }

  if (mapping.role === TEAM_ROLE.OWNER) {
    throw new ScimOwnerProtectedError();
  }

  const requestedUserIds = new Set(data.memberUserIds);

  const currentMembers = await prisma.teamMember.findMany({
    where: { teamId: mapping.teamId, role: mapping.role, deactivatedAt: null },
    select: { id: true, userId: true, role: true },
  });
  const currentUserIds = new Set(currentMembers.map((m) => m.userId));

  const toAdd = [...requestedUserIds].filter((uid) => !currentUserIds.has(uid));
  const toRemove = currentMembers.filter((m) => !requestedUserIds.has(m.userId));

  try {
    await prisma.$transaction(async (tx) => {
      for (const userId of toAdd) {
        const member = await tx.teamMember.findUnique({
          where: { teamId_userId: { teamId: mapping.teamId, userId } },
          select: { id: true, role: true },
        });
        if (!member) {
          const tenantMemberId = await resolveActiveTenantMemberId(tx, tenantId, userId);
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
        const userId = e.message.slice("SCIM_NO_SUCH_MEMBER:".length);
        throw new ScimNoSuchMemberError(userId);
      }
      if (e.message === "SCIM_OWNER_PROTECTED") {
        throw new ScimOwnerProtectedError();
      }
    }
    throw e;
  }

  const members = await loadGroupMembers(mapping.teamId, mapping.role);
  const resource = buildGroupResource(
    mapping.externalGroupId,
    toDisplayName(mapping.team.slug, mapping.role),
    members,
    baseUrl,
  );

  return {
    resource,
    teamId: mapping.teamId,
    role: mapping.role,
    added: toAdd.length,
    removed: toRemove.length,
  };
}

/**
 * Partial-update a SCIM Group's members (PATCH semantics).
 *
 * Applies a list of add/remove actions parsed from the SCIM PATCH Operations array.
 * Owner-role members are always protected from modification.
 *
 * Throws:
 * - `ScimGroupNotFoundError` — no mapping found for tenantId + scimId
 * - `ScimOwnerProtectedError` — attempted to modify an OWNER member
 * - `ScimNoSuchMemberError` — a referenced userId is not an active tenant member (add op),
 *   or does not exist as a team member (remove op)
 */
export async function patchScimGroup(
  tenantId: string,
  scimId: string,
  operations: GroupMemberAction[],
  baseUrl: string,
): Promise<ScimGroupPatchResult> {
  const mapping = await prisma.scimGroupMapping.findUnique({
    where: {
      tenantId_externalGroupId: {
        tenantId,
        externalGroupId: scimId,
      },
    },
    select: {
      externalGroupId: true,
      role: true,
      teamId: true,
      team: { select: { slug: true } },
    },
  });
  if (!mapping) throw new ScimGroupNotFoundError();

  try {
    await prisma.$transaction(async (tx) => {
      for (const action of operations) {
        const member = await tx.teamMember.findUnique({
          where: { teamId_userId: { teamId: mapping.teamId, userId: action.userId } },
          select: { id: true, role: true },
        });
        if (action.op === "add") {
          if (!member) {
            const tenantMemberId = await resolveActiveTenantMemberId(tx, tenantId, action.userId);
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
            await tx.teamMember.update({
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
        const userId = e.message.slice("SCIM_NO_SUCH_MEMBER:".length);
        throw new ScimNoSuchMemberError(userId);
      }
      if (e.message === "SCIM_OWNER_PROTECTED") {
        throw new ScimOwnerProtectedError();
      }
    }
    throw e;
  }

  const members = await loadGroupMembers(mapping.teamId, mapping.role);
  const resource = buildGroupResource(
    mapping.externalGroupId,
    toDisplayName(mapping.team.slug, mapping.role),
    members,
    baseUrl,
  );

  return {
    resource,
    teamId: mapping.teamId,
    role: mapping.role,
  };
}

/**
 * Delete a SCIM Group (DELETE semantics).
 *
 * Role-based groups cannot be deleted via SCIM. This function always throws
 * `ScimGroupNotFoundError`. The route handler should return 405 Method Not Allowed
 * without calling this function.
 */
export async function deleteScimGroup(_tenantId: string, _teamId: string): Promise<void> {
  // Role-based groups are never deletable — route returns 405 before reaching here.
  throw new ScimGroupNotFoundError();
}
