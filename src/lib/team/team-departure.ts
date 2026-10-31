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
 * (scripts/checks/check-team-rotation-input-lock.mjs).
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
 * and, with them, their memberships of the tenant's teams. Returns the users
 * that transitioned; callers derive audit, session invalidation and counters
 * from it, not from a pre-read. Re-deactivating a deactivated user is a
 * no-op: the stamp is written once, so a membership re-admitted after the
 * departure stays.
 *
 * MUST run inside a transaction under the tenant's RLS context.
 */
export async function departFromTenant(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
  options: TenantTransitionOptions,
): Promise<string[]> {
  if (userIds.length === 0) return [];
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
  if (transitioned.length === 0) return [];
  await endTeamMemberships(tx, tenantId, transitioned, options);
  return transitioned;
}

/**
 * Reactivate the users' memberships of `tenantId` and restore the team
 * memberships their departure ended (the marked ones). Returns the users
 * that transitioned.
 *
 * MUST run inside a transaction under the tenant's RLS context.
 */
export async function returnToTenant(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
  options: TenantTransitionOptions,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  if (!options.alreadyLocked) await lockTenantRows(tx, tenantId, userIds, "update", options.budget);

  const transitioned = (
    await tx.$queryRaw<{ user_id: string }[]>`
      UPDATE tenant_members SET deactivated_at = NULL, updated_at = clock_timestamp()
       WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${[...userIds]}::uuid[])
         AND deactivated_at IS NOT NULL
      RETURNING user_id
    `
  ).map((row) => row.user_id);
  if (transitioned.length === 0) return [];

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
  return transitioned;
}

/**
 * A tenant membership row INSERTed deactivated (SCIM POST `active=false`,
 * directory-sync create of a deactivated user): the user may already hold
 * memberships of the tenant's teams as a guest, so this is a departure.
 * The row cannot be created active first (`tenant_members_one_active_per_user`
 * refuses a user active elsewhere), so the caller inserts it deactivated
 * after lockTenantMemberCreation, and this restamps it with the database
 * clock and ends the team memberships.
 */
export async function departCreatedMembership(
  tx: Tx,
  tenantId: string,
  userId: string,
  options: Omit<TenantTransitionOptions, "alreadyLocked">,
): Promise<void> {
  const stamped = await tx.$executeRaw`
    UPDATE tenant_members SET deactivated_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid AND deactivated_at IS NOT NULL
  `;
  if (stamped !== 1) throw new Error("departCreatedMembership: no deactivated row to stamp");
  await endTeamMemberships(tx, tenantId, [userId], options);
}
