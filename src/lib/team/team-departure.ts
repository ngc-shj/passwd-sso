import type { Prisma } from "@prisma/client";
import { logAuditInTx, type AuditLogParams } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import {
  type LockBudget,
  assertTeamsLocked,
  lockTeamsAgainstRotation,
} from "@/lib/team/team-key-rotation-lock";
import { lockTenantRows } from "@/lib/team/tenant-row-lock";
import { endCreatorFootholdsInTx } from "@/lib/tenant/departure-footholds";
import {
  type UserAuthArtifactCounts,
  revokeUsersAuthArtifactsInTx,
} from "@/lib/auth/session/user-session-invalidation";

/**
 * A user's membership of a tenant is the gate to their memberships of that
 * tenant's teams (docs/archive/review/team-tenant-departure-plan.md C2/C3).
 *
 * Departure writes the state every team reader already honours —
 * `team_members.deactivated_at` — plus `deactivated_by_tenant`, so a return
 * restores exactly the memberships the departure ended. It is NOT
 * `key_distributed = false`: admin browsers redistribute that state.
 *
 * These are the only writers that move `tenant_members.deactivated_at`
 * (scripts/checks/check-team-rotation-input-lock.mjs). The database refuses a
 * commit that departs a user while leaving them an active membership of the
 * tenant's teams (departed_member_guard, migration 20261117000100), so every
 * departure here ends all of them, not only those admitted before it.
 *
 * Every departure and every return revokes the users' sessions and tokens in
 * the tenant in its own transaction, as its last step, so it cannot commit
 * without the revocation (docs/archive/review/session-revocation-failure-surfaces-plan.md
 * C2). The credential lock is taken last within each call, then the rows of the
 * footholds the users minted (endCreatorFootholdsInTx). A transaction that
 * calls several times (directory sync) or writes after the call (SCIM PUT's
 * external mapping) holds it across those later writes; what holds is that no
 * mint holding it waits on a row these transactions hold.
 */

export const TENANT_MEMBERSHIP_SOURCE = {
  TENANT_DEACTIVATION: "TENANT_DEACTIVATION",
  TENANT_REACTIVATION: "TENANT_REACTIVATION",
} as const;

/** Who caused the transition, for the per-membership audit rows. */
export type DepartureAuditActor = Pick<
  AuditLogParams,
  "userId" | "actorType" | "serviceAccountId" | "ip" | "userAgent"
>;

export type TenantTransitionOptions = {
  actor: DepartureAuditActor;
  budget?: LockBudget;
  /**
   * The caller already locked a superset of `userIds` with lockTenantRows
   * in "update" mode — its one tenant-row lock call (directory sync, SCIM
   * DELETE). Skips step 1.
   */
  alreadyLocked?: boolean;
};

type Tx = Prisma.TransactionClient;

/**
 * What a departure revoked. The caller tombstones `sessionTokens` in the
 * session cache after its transaction commits (tombstoneRevokedSessions).
 */
export type DepartureRevocation = { counts: UserAuthArtifactCounts; sessionTokens: string[] };

/** The departing users' credentials in this tenant, waiting on their lock for a bounded time. */
function revokeInTenant(tenantId: string) {
  return { tenantFilter: { tenantId }, boundedLockWait: true };
}

async function activeMembershipTeams(tx: Tx, tenantId: string, userIds: readonly string[]): Promise<string[]> {
  const rows = await tx.$queryRaw<{ team_id: string }[]>`
    SELECT DISTINCT team_id FROM team_members
     WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${userIds}::uuid[]) AND deactivated_at IS NULL
  `;
  return rows.map((row) => row.team_id);
}

/**
 * Steps 3–5 of a departure, for users whose tenant row was just stamped
 * deactivated under its lock: lock their teams, expire the invitations they
 * issued, and end their active memberships of the tenant's teams with the
 * marker (stamped with the tenant row's value).
 */
async function endTeamMemberships(
  tx: Tx,
  tenantId: string,
  transitioned: readonly string[],
  options: TenantTransitionOptions,
): Promise<void> {
  // Every admission writer holds the user's tenant row (or its advisory
  // lock) before inserting a membership, so this set cannot grow now.
  const teamIds = await activeMembershipTeams(tx, tenantId, transitioned);
  await lockTeamsAgainstRotation(tx, teamIds, options.budget);

  await tx.$executeRaw`
    UPDATE team_invitations SET status = 'EXPIRED', updated_at = clock_timestamp()
     WHERE tenant_id = ${tenantId}::uuid AND invited_by_id = ANY(${[...transitioned]}::uuid[]) AND status = 'PENDING'
  `;

  const ended = await tx.$queryRaw<{ team_id: string; user_id: string }[]>`
    UPDATE team_members tm
       SET deactivated_at = tmb.deactivated_at, deactivated_by_tenant = true, updated_at = clock_timestamp()
      FROM tenant_members tmb
     WHERE tm.tenant_id = ${tenantId}::uuid AND tm.user_id = ANY(${[...transitioned]}::uuid[])
       AND tm.deactivated_at IS NULL
       AND tmb.tenant_id = tm.tenant_id AND tmb.user_id = tm.user_id
    RETURNING tm.team_id, tm.user_id
  `;
  assertTeamsLocked(new Set(teamIds), ended.map((row) => row.team_id));

  for (const row of ended) {
    await logAuditInTx(tx, tenantId, {
      ...options.actor,
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.TEAM_MEMBER_TENANT_DEACTIVATE,
      tenantId,
      teamId: row.team_id,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: row.user_id,
      metadata: { source: TENANT_MEMBERSHIP_SOURCE.TENANT_DEACTIVATION },
    });
  }
}

/**
 * Deactivate the users' memberships of `tenantId` (tenant OWNER excepted)
 * and, with them, their memberships of the tenant's teams, and revoke the
 * credentials of exactly the users that transitioned. Returns those users;
 * callers derive audit and counters from them, not from a pre-read.
 * Re-deactivating a deactivated user is a no-op that revokes nothing: the
 * stamp is written once, so a membership re-admitted after the departure
 * stays.
 *
 * MUST run inside a transaction under the tenant's RLS context.
 */
export async function departFromTenant(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
  options: TenantTransitionOptions,
): Promise<{ userIds: string[]; revocation: DepartureRevocation }> {
  if (userIds.length === 0) {
    return { userIds: [], revocation: await revokeUsersAuthArtifactsInTx(tx, [], revokeInTenant(tenantId)) };
  }
  if (!options.alreadyLocked) await lockTenantRows(tx, tenantId, userIds, "update", options.budget);

  // clock_timestamp(), not now(): the stamp is compared with invitations'
  // created_at, so it must be taken after the row lock, not at transaction
  // start (a directory-sync run is one long transaction).
  const transitioned = (
    await tx.$queryRaw<{ user_id: string }[]>`
      UPDATE tenant_members
         SET deactivated_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${[...userIds]}::uuid[])
         AND deactivated_at IS NULL AND role <> 'OWNER'
      RETURNING user_id
    `
  ).map((row) => row.user_id);
  if (transitioned.length > 0) await endTeamMemberships(tx, tenantId, transitioned, options);
  // Last, after the team locks and writes (C1 lock order), on a budget of its
  // own: a directory-sync run spends the transition budget on its own work.
  const revocation = await revokeUsersAuthArtifactsInTx(tx, transitioned, revokeInTenant(tenantId));
  await endCreatorFootholdsInTx(tx, tenantId, transitioned, options.actor);
  return { userIds: transitioned, revocation };
}

/**
 * Reactivate the users' memberships of `tenantId` and restore the team
 * memberships their departure ended (the marked ones), then revoke the
 * credentials of exactly the users that transitioned. Returns those users.
 *
 * MUST run inside a transaction under the tenant's RLS context.
 */
export async function returnToTenant(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
  options: TenantTransitionOptions,
): Promise<{ userIds: string[]; revocation: DepartureRevocation }> {
  if (userIds.length === 0) {
    return { userIds: [], revocation: await revokeUsersAuthArtifactsInTx(tx, [], revokeInTenant(tenantId)) };
  }
  if (!options.alreadyLocked) await lockTenantRows(tx, tenantId, userIds, "update", options.budget);

  const transitioned = (
    await tx.$queryRaw<{ user_id: string }[]>`
      UPDATE tenant_members SET deactivated_at = NULL, updated_at = clock_timestamp()
       WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${[...userIds]}::uuid[])
         AND deactivated_at IS NOT NULL
      RETURNING user_id
    `
  ).map((row) => row.user_id);
  if (transitioned.length === 0) {
    return { userIds: [], revocation: await revokeUsersAuthArtifactsInTx(tx, [], revokeInTenant(tenantId)) };
  }

  const teamRows = await tx.$queryRaw<{ team_id: string }[]>`
    SELECT DISTINCT team_id FROM team_members
     WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${transitioned}::uuid[]) AND deactivated_by_tenant
  `;
  const teamIds = teamRows.map((row) => row.team_id);
  await lockTeamsAgainstRotation(tx, teamIds, options.budget);

  const restored = await tx.$queryRaw<{ team_id: string; user_id: string }[]>`
    UPDATE team_members
       SET deactivated_at = NULL, deactivated_by_tenant = false, updated_at = clock_timestamp()
     WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${transitioned}::uuid[]) AND deactivated_by_tenant
    RETURNING team_id, user_id
  `;
  assertTeamsLocked(new Set(teamIds), restored.map((row) => row.team_id));

  for (const row of restored) {
    await logAuditInTx(tx, tenantId, {
      ...options.actor,
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.TEAM_MEMBER_TENANT_RESTORE,
      tenantId,
      teamId: row.team_id,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: row.user_id,
      metadata: { source: TENANT_MEMBERSHIP_SOURCE.TENANT_REACTIVATION },
    });
  }
  // Whatever the user holds in this tenant now was minted before the departure
  // or without an active membership: departures made before revocation was
  // atomic (every directory-sync one, swallowed SCIM/team failures) left such
  // credentials alive, and the return would otherwise revive them.
  // Last, as in departFromTenant (C1 lock order).
  const revocation = await revokeUsersAuthArtifactsInTx(tx, transitioned, revokeInTenant(tenantId));
  await endCreatorFootholdsInTx(tx, tenantId, transitioned, options.actor);
  return { userIds: transitioned, revocation };
}

/**
 * A tenant membership row INSERTed deactivated (SCIM POST `active=false`,
 * directory-sync create of a deactivated user): the user may already hold
 * memberships of the tenant's teams as a guest, so this is a departure.
 * The row cannot be created active first (`tenant_members_one_active_per_user`
 * refuses a user active elsewhere), so the caller inserts it deactivated
 * after lockTenantMemberCreation, and this restamps it with the database
 * clock, ends the team memberships and revokes what the user holds in the
 * tenant.
 */
export async function departCreatedMembership(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
  options: Omit<TenantTransitionOptions, "alreadyLocked">,
): Promise<DepartureRevocation> {
  if (userIds.length === 0) return revokeUsersAuthArtifactsInTx(tx, [], revokeInTenant(tenantId));
  const stamped = await tx.$executeRaw`
    UPDATE tenant_members SET deactivated_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${[...userIds]}::uuid[]) AND deactivated_at IS NOT NULL
  `;
  if (stamped !== userIds.length) throw new Error("departCreatedMembership: a created row is not deactivated");
  await endTeamMemberships(tx, tenantId, userIds, options);
  const revocation = await revokeUsersAuthArtifactsInTx(tx, userIds, revokeInTenant(tenantId));
  await endCreatorFootholdsInTx(tx, tenantId, userIds, options.actor);
  return revocation;
}
