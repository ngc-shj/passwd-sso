/**
 * SCIM Group service — Prisma queries and data transformation for SCIM Group operations.
 *
 * All functions must be called within a `withTenantRls()` context, passing its
 * transaction: the add/remove writes, the tenant-row and team locks they run
 * under, and the route's audit emission all share that one transaction.
 */

import { prisma, type TxOrPrisma } from "@/lib/prisma";
import { type LockBudget, createLockBudget, lockTeamsAgainstRotation } from "@/lib/team/team-key-rotation-lock";
import { type LockedTenantRow, lockTenantRows } from "@/lib/team/tenant-row-lock";
import type { Prisma, TeamRole } from "@prisma/client";
import type { ScimGroupMemberInput, ScimGroupResource } from "@/lib/scim/serializers";
import type { GroupMemberAction } from "@/lib/scim/patch-parser";
import { TEAM_ROLE } from "@/lib/constants";
import { SCIM_GROUP_ROW_STATE, scimGroupResponseMemberWhere } from "@/lib/scim/scim-group-members";

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

// ── Transitions ───────────────────────────────────────────────

/**
 * Per-user outcomes of a SCIM Group write (C2/C4). The route maps these to
 * TEAM-scope audit actions through an exhaustive `Record<ScimTransitionKind,
 * AuditAction>` — a new kind here is a compile error there.
 */
export const SCIM_TRANSITION_KIND = {
  BECAME_PENDING: "becamePending",
  PENDING_ROLE_RAISED: "pendingRoleRaised",
  PENDING_WITHDRAWN: "pendingWithdrawn",
  ACTIVE_REMOVED: "activeRemoved",
  DEPARTED_UNMARKED: "departedUnmarked",
  ACTIVE_ROLE_CHANGED: "activeRoleChanged",
} as const;

export type ScimTransitionKind = (typeof SCIM_TRANSITION_KIND)[keyof typeof SCIM_TRANSITION_KIND];

export interface ScimMemberTransition {
  kind: ScimTransitionKind;
  userId: string;
  /** The role the transition leaves the row at (the group's role). */
  role: TeamRole;
  /** Known only when the write returned it (updateManyAndReturn); createMany does not. */
  memberId?: string;
  /** The row's role before a pendingRoleRaised / activeRoleChanged transition. */
  previousRole?: TeamRole;
}

// ── Result types ──────────────────────────────────────────────

export interface ScimGroupReplaceResult {
  resource: ScimGroupResource;
  teamId: string;
  role: TeamRole;
  added: number;
  removed: number;
  transitions: ScimMemberTransition[];
}

export interface ScimGroupPatchResult {
  resource: ScimGroupResource;
  teamId: string;
  role: TeamRole;
  added: number;
  removed: number;
  transitions: ScimMemberTransition[];
}

/**
 * `added`/`removed` for `SCIM_GROUP_UPDATE` metadata, from the transitions a
 * write actually produced rather than the requested lists (so a no-op add or
 * remove — a repeated PUT, a withdraw whose row the lock already covers —
 * does not count). Shared by PUT and PATCH (F3).
 */
function countAddedRemoved(transitions: ScimMemberTransition[]): { added: number; removed: number } {
  const added = transitions.filter((t) =>
    t.kind === SCIM_TRANSITION_KIND.BECAME_PENDING ||
    t.kind === SCIM_TRANSITION_KIND.PENDING_ROLE_RAISED ||
    t.kind === SCIM_TRANSITION_KIND.ACTIVE_ROLE_CHANGED,
  ).length;
  return { added, removed: transitions.length - added };
}

// ── Error classes ─────────────────────────────────────────────

export class ScimGroupNotFoundError extends Error {
  constructor() {
    super("Group not found");
    this.name = "ScimGroupNotFoundError";
  }
}

import { ScimOwnerProtectedError } from "@/lib/scim/errors";
export { ScimOwnerProtectedError };

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

/**
 * A remove candidate's pending row was gone by the time the locked re-read's
 * own delete ran (only an unlocked writer — the Auth.js `deleteUser` cascade
 * — can cause this, since every other writer of this row takes the same
 * tenant advisory lock `lockGroupWrite` already holds). Rolls the whole
 * request back so the IdP's retry emits exact transitions.
 */
export class ScimMembershipChangedError extends Error {
  constructor() {
    super("A member's membership changed during the update");
    this.name = "ScimMembershipChangedError";
  }
}

// ── Internal helpers ──────────────────────────────────────────

/** Re-throw SCIM-specific sentinel errors as typed error classes. */
function rethrowScimGroupErrors(e: unknown): never {
  if (e instanceof Error) {
    if (e.message.startsWith("SCIM_NO_SUCH_MEMBER:")) {
      throw new ScimNoSuchMemberError(e.message.slice("SCIM_NO_SUCH_MEMBER:".length));
    }
    if (e.message === "SCIM_OWNER_PROTECTED") {
      throw new ScimOwnerProtectedError();
    }
  }
  throw e;
}

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

async function loadGroupMembers(
  db: TxOrPrisma,
  tenantId: string,
  teamId: string,
  role: TeamRole,
): Promise<ScimGroupMemberInput[]> {
  const members = await db.teamMember.findMany({
    where: { teamId, role, ...scimGroupResponseMemberWhere(tenantId) },
    include: { user: { select: { id: true, email: true } } },
  });
  return members
    .filter((m) => m.user.email != null)
    .map((m) => ({ userId: m.userId, email: m.user.email! }));
}

/**
 * SCIM group membership role order: a pending row is raised to the HIGHER of
 * its current role and an incoming mapping's role, never lowered by an add.
 * OWNER never reaches here (SCIM groups exclude it), kept only so the map is
 * exhaustive over `TeamRole`.
 */
const SCIM_ROLE_RANK: Record<TeamRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
  VIEWER: 0,
};

function higherRole(a: TeamRole, b: TeamRole): TeamRole {
  return SCIM_ROLE_RANK[a] >= SCIM_ROLE_RANK[b] ? a : b;
}

/**
 * RFC 7644 §3.5.2: PATCH operations apply in the order given. `actions`
 * preserves that order (patch-parser.ts) across op kinds, so a userId named
 * by both an add and a remove op resolves to whichever one appears last —
 * `[remove X, add X]` leaves X added, `[add X, remove X]` leaves X removed.
 * Splitting into independent add/remove lists without this fold (the
 * pre-fix behaviour) always ran adds before removes regardless of request
 * order (review round 2, F-N4/T-N7).
 */
function foldPatchOperations(actions: GroupMemberAction[]): { addUserIds: string[]; removeUserIds: string[] } {
  const lastOpByUserId = new Map<string, GroupMemberAction["op"]>();
  for (const { op, userId } of actions) {
    lastOpByUserId.set(userId, op);
  }
  const addUserIds: string[] = [];
  const removeUserIds: string[] = [];
  for (const [userId, op] of lastOpByUserId) {
    (op === "add" ? addUserIds : removeUserIds).push(userId);
  }
  return { addUserIds, removeUserIds };
}

/**
 * Lock order for a group write (tenant-row-lock.ts): the tenant rows of the
 * users it may admit or remove, then the team. Returns the locked rows for
 * applyAddOperations.
 */
async function lockGroupWrite(
  tx: Prisma.TransactionClient,
  tenantId: string,
  teamId: string,
  candidateUserIds: readonly string[],
): Promise<Map<string, LockedTenantRow>> {
  const budget: LockBudget = createLockBudget();
  const rows = await lockTenantRows(tx, tenantId, candidateUserIds, "share", budget);
  // Deactivation serialises with key rotation (team-key-rotation-lock.ts).
  await lockTeamsAgainstRotation(tx, [teamId], budget);
  return rows;
}

/**
 * Apply SCIM Group member additions (C2). A user active in the tenant always
 * ends up with a row at `role` — created pending, raised from a lower
 * pending role, moved from deactivated to pending, or (already active)
 * role-changed in place. A user inactive in the tenant leaves a
 * departure-marked or pending row untouched; anything else is
 * `ScimNoSuchMemberError`.
 */
async function applyAddOperations(
  tx: Prisma.TransactionClient,
  teamId: string,
  tenantId: string,
  role: TeamRole,
  userIds: string[],
  tenantRows: ReadonlyMap<string, LockedTenantRow>,
): Promise<ScimMemberTransition[]> {
  if (userIds.length === 0) return [];

  const memberships = await tx.teamMember.findMany({
    where: { teamId, userId: { in: userIds } },
    select: {
      id: true,
      userId: true,
      role: true,
      deactivatedAt: true,
      deactivatedByTenant: true,
      scimApprovalPending: true,
    },
  });
  const membershipByUserId = new Map(memberships.map((m) => [m.userId, m]));

  for (const m of memberships) {
    if (m.deactivatedAt === null && m.role === TEAM_ROLE.OWNER) {
      throw new Error("SCIM_OWNER_PROTECTED");
    }
  }

  const toCreateUserIds: string[] = [];
  const toBecomePending: { id: string; userId: string }[] = [];
  const toRaiseByPreviousRole = new Map<TeamRole, string[]>();
  const toUpdateRoleByPreviousRole = new Map<TeamRole, string[]>();

  for (const uid of userIds) {
    const membership = membershipByUserId.get(uid);
    const tenantRow = tenantRows.get(uid);
    const activeInTenant = tenantRow?.hasRow === true && tenantRow.deactivatedAt === null;

    if (!activeInTenant) {
      // A departure-marked or a pending row of a user who left the tenant is
      // already present as far as the IdP's group is concerned: left as-is,
      // not re-thrown as missing (a return, or an approval, is what
      // reactivates it).
      if (membership?.deactivatedByTenant || membership?.scimApprovalPending) continue;
      throw new Error(`SCIM_NO_SUCH_MEMBER:${uid}`);
    }

    if (!membership) {
      toCreateUserIds.push(uid);
      continue;
    }

    if (membership.scimApprovalPending) {
      const raised = higherRole(membership.role, role);
      if (raised !== membership.role) {
        const ids = toRaiseByPreviousRole.get(membership.role) ?? [];
        ids.push(membership.id);
        toRaiseByPreviousRole.set(membership.role, ids);
      }
      continue;
    }

    if (membership.deactivatedAt !== null) {
      toBecomePending.push({ id: membership.id, userId: uid });
      continue;
    }

    if (membership.role !== role) {
      const ids = toUpdateRoleByPreviousRole.get(membership.role) ?? [];
      ids.push(membership.id);
      toUpdateRoleByPreviousRole.set(membership.role, ids);
    }
  }

  const transitions: ScimMemberTransition[] = [];

  if (toCreateUserIds.length > 0) {
    await tx.teamMember.createMany({
      data: toCreateUserIds.map((uid) => ({
        teamId,
        userId: uid,
        tenantId,
        role,
        scimManaged: true,
        scimApprovalPending: true,
        deactivatedAt: new Date(),
        keyDistributed: false,
      })),
    });
    for (const uid of toCreateUserIds) {
      transitions.push({ kind: SCIM_TRANSITION_KIND.BECAME_PENDING, userId: uid, role });
    }
  }

  if (toBecomePending.length > 0) {
    // A deactivated non-pending membership of an active tenant member
    // becomes pending: stale keys are cleared so an eventual approval
    // distributes the current team key, not one wrapped for a membership
    // that already ended.
    await tx.teamMemberKey.deleteMany({
      where: { teamId, userId: { in: toBecomePending.map((m) => m.userId) } },
    });
    // CAS on the state the pre-read saw: a team-side DELETE does not take the
    // user's advisory lock, so the transitions come from the rows written.
    const rows = await tx.teamMember.updateManyAndReturn({
      where: {
        id: { in: toBecomePending.map((m) => m.id) },
        teamId,
        deactivatedAt: { not: null },
        scimApprovalPending: false,
      },
      data: {
        scimManaged: true,
        scimApprovalPending: true,
        deactivatedByTenant: false,
        keyDistributed: false,
        role,
      },
      select: { id: true, userId: true },
    });
    for (const row of rows) {
      transitions.push({ kind: SCIM_TRANSITION_KIND.BECAME_PENDING, userId: row.userId, role, memberId: row.id });
    }
  }

  for (const [previousRole, ids] of toRaiseByPreviousRole) {
    const rows = await tx.teamMember.updateManyAndReturn({
      where: { id: { in: ids }, teamId, role: previousRole, scimApprovalPending: true },
      data: { role },
      select: { id: true, userId: true },
    });
    for (const row of rows) {
      transitions.push({
        kind: SCIM_TRANSITION_KIND.PENDING_ROLE_RAISED,
        userId: row.userId,
        role,
        previousRole,
        memberId: row.id,
      });
    }
  }

  for (const [previousRole, ids] of toUpdateRoleByPreviousRole) {
    const rows = await tx.teamMember.updateManyAndReturn({
      where: { id: { in: ids }, teamId, role: previousRole, deactivatedAt: null },
      data: { role },
      select: { id: true, userId: true },
    });
    for (const row of rows) {
      transitions.push({
        kind: SCIM_TRANSITION_KIND.ACTIVE_ROLE_CHANGED,
        userId: row.userId,
        role,
        previousRole,
        memberId: row.id,
      });
    }
  }

  return transitions;
}

/**
 * Apply SCIM Group member removals (C2): set-based CAS writes, one statement
 * per row kind, with transitions derived from what each write returned —
 * never from the pre-read. `removeUserIds`' tenant rows are already locked by
 * `lockGroupWrite`, so the `findMany` below is a locked re-read, not a race
 * with a concurrent departure or approval.
 *
 * A user with no row in the team at all is a no-op (not `ScimNoSuchMemberError`
 * — an absent member is idempotent on an IdP retry). A row whose role does not
 * match this group's role is also left alone (it belongs to a different
 * role-group, or none).
 */
async function applyRemoveOperations(
  tx: Prisma.TransactionClient,
  teamId: string,
  role: TeamRole,
  removeUserIds: string[],
): Promise<ScimMemberTransition[]> {
  if (removeUserIds.length === 0) return [];

  const freshMembers = await tx.teamMember.findMany({
    where: { teamId, userId: { in: removeUserIds } },
    select: {
      id: true,
      userId: true,
      role: true,
      deactivatedAt: true,
      deactivatedByTenant: true,
      scimApprovalPending: true,
    },
  });

  for (const m of freshMembers) {
    if (m.role === TEAM_ROLE.OWNER) {
      throw new Error("SCIM_OWNER_PROTECTED");
    }
  }

  const candidates = freshMembers.filter((m) => m.role === role);
  const pending = candidates.filter((m) => m.scimApprovalPending);
  const active = candidates.filter((m) => m.deactivatedAt === null);
  const departed = candidates.filter(
    (m) => m.deactivatedAt !== null && m.deactivatedByTenant && !m.scimApprovalPending,
  );

  const transitions: ScimMemberTransition[] = [];

  if (pending.length > 0) {
    const pendingIds = pending.map((m) => m.id);
    const { count } = await tx.teamMember.deleteMany({
      where: { id: { in: pendingIds }, teamId, role, scimApprovalPending: true },
    });
    if (count !== pendingIds.length) {
      throw new ScimMembershipChangedError();
    }
    for (const m of pending) {
      transitions.push({ kind: SCIM_TRANSITION_KIND.PENDING_WITHDRAWN, userId: m.userId, role, memberId: m.id });
    }
  }

  if (active.length > 0) {
    const rows = await tx.teamMember.updateManyAndReturn({
      where: { id: { in: active.map((m) => m.id) }, teamId, role, deactivatedAt: null },
      data: { deactivatedAt: new Date() },
      select: { id: true, userId: true },
    });
    for (const row of rows) {
      transitions.push({ kind: SCIM_TRANSITION_KIND.ACTIVE_REMOVED, userId: row.userId, role, memberId: row.id });
    }
  }

  if (departed.length > 0) {
    const rows = await tx.teamMember.updateManyAndReturn({
      where: { id: { in: departed.map((m) => m.id) }, teamId, role, deactivatedByTenant: true },
      data: { deactivatedByTenant: false },
      select: { id: true, userId: true },
    });
    for (const row of rows) {
      transitions.push({ kind: SCIM_TRANSITION_KIND.DEPARTED_UNMARKED, userId: row.userId, role, memberId: row.id });
    }
  }

  return transitions;
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
  db: TxOrPrisma = prisma,
): Promise<ScimGroupResource | null> {
  const mapping = await db.scimGroupMapping.findUnique({
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

  const members = await loadGroupMembers(db, tenantId, mapping.teamId, mapping.role);
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
 * them in the caller's transaction. Owner-role groups and OWNER-role members
 * are always protected from modification.
 *
 * Throws:
 * - `ScimGroupNotFoundError` — no mapping found for tenantId + scimId
 * - `ScimOwnerProtectedError` — attempted to modify an OWNER-role group or an OWNER member
 * - `ScimNoSuchMemberError` — a referenced userId is not an active tenant member
 * - `ScimMembershipChangedError` — a pending row removed here vanished between
 *   the locked re-read and its delete
 */
export async function replaceScimGroup(
  tenantId: string,
  scimId: string,
  data: ScimGroupReplaceInput,
  baseUrl: string,
  tx: Prisma.TransactionClient,
): Promise<ScimGroupReplaceResult> {
  const mapping = await tx.scimGroupMapping.findUnique({
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

  let transitions: ScimMemberTransition[] = [];

  try {
    // Unlocked pre-read: only used to decide which users' tenant rows need
    // locking (requested users ∪ the group's pre-lock members) before the
    // delta is computed again under that lock.
    const preReadMembers = await tx.teamMember.findMany({
      where: { teamId: mapping.teamId, role: mapping.role, ...SCIM_GROUP_ROW_STATE },
      select: { userId: true },
    });
    const lockCandidates = new Set([...requestedUserIds, ...preReadMembers.map((m) => m.userId)]);
    const tenantRows = await lockGroupWrite(tx, tenantId, mapping.teamId, [...lockCandidates]);

    // Locked re-read: a membership the user's tenant departure ended is still
    // the group's — listed by the IdP it is kept as it is, omitted it is
    // removed (applyRemoveOperations).
    const currentMembers = await tx.teamMember.findMany({
      where: { teamId: mapping.teamId, role: mapping.role, ...SCIM_GROUP_ROW_STATE },
      select: { id: true, userId: true, role: true },
    });
    const currentUserIds = new Set(currentMembers.map((m) => m.userId));

    const toAdd = [...requestedUserIds].filter((uid) => !currentUserIds.has(uid));
    // A member the locked re-read found whose user is outside the locked set
    // joined after the pre-read; this PUT does not hold their tenant-row
    // lock and leaves them for the next sync.
    const toRemove = currentMembers.filter(
      (m) => !requestedUserIds.has(m.userId) && tenantRows.has(m.userId),
    );

    const addTransitions = await applyAddOperations(
      tx,
      mapping.teamId,
      tenantId,
      mapping.role,
      toAdd,
      tenantRows,
    );
    const removeTransitions = await applyRemoveOperations(
      tx,
      mapping.teamId,
      mapping.role,
      toRemove.map((m) => m.userId),
    );
    transitions = [...addTransitions, ...removeTransitions];
  } catch (e) {
    rethrowScimGroupErrors(e);
  }

  const members = await loadGroupMembers(tx, tenantId, mapping.teamId, mapping.role);
  const resource = buildGroupResource(
    mapping.externalGroupId,
    toDisplayName(mapping.team.slug, mapping.role),
    members,
    baseUrl,
  );

  const { added, removed } = countAddedRemoved(transitions);

  return {
    resource,
    teamId: mapping.teamId,
    role: mapping.role,
    added,
    removed,
    transitions,
  };
}

/**
 * Partial-update a SCIM Group's members (PATCH semantics).
 *
 * Applies a list of add/remove actions parsed from the SCIM PATCH Operations
 * array, folded per userId to the last op in request order (RFC 7644
 * §3.5.2 — `foldPatchOperations`). Owner-role members are always protected
 * from modification.
 *
 * Throws:
 * - `ScimGroupNotFoundError` — no mapping found for tenantId + scimId
 * - `ScimOwnerProtectedError` — attempted to modify an OWNER member
 * - `ScimNoSuchMemberError` — a referenced userId is not an active tenant member (add op)
 * - `ScimMembershipChangedError` — a pending row removed here vanished between
 *   the locked re-read and its delete
 */
export async function patchScimGroup(
  tenantId: string,
  scimId: string,
  operations: GroupMemberAction[],
  baseUrl: string,
  tx: Prisma.TransactionClient,
): Promise<ScimGroupPatchResult> {
  const mapping = await tx.scimGroupMapping.findUnique({
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

  let transitions: ScimMemberTransition[] = [];

  try {
    const { addUserIds, removeUserIds } = foldPatchOperations(operations);
    const tenantRows = await lockGroupWrite(tx, tenantId, mapping.teamId, [
      ...addUserIds,
      ...removeUserIds,
    ]);

    const addTransitions = await applyAddOperations(
      tx,
      mapping.teamId,
      tenantId,
      mapping.role,
      addUserIds,
      tenantRows,
    );
    const removeTransitions = await applyRemoveOperations(
      tx,
      mapping.teamId,
      mapping.role,
      removeUserIds,
    );
    transitions = [...addTransitions, ...removeTransitions];
  } catch (e) {
    rethrowScimGroupErrors(e);
  }

  const members = await loadGroupMembers(tx, tenantId, mapping.teamId, mapping.role);
  const resource = buildGroupResource(
    mapping.externalGroupId,
    toDisplayName(mapping.team.slug, mapping.role),
    members,
    baseUrl,
  );

  const { added, removed } = countAddedRemoved(transitions);

  return {
    resource,
    teamId: mapping.teamId,
    role: mapping.role,
    added,
    removed,
    transitions,
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
