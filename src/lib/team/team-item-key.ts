import type { Prisma, TeamRole } from "@prisma/client";
import { hasTeamPermission } from "@/lib/auth/access/team-auth";
import { TEAM_PERMISSION } from "@/lib/constants";
import { actorDepartedSinceAdmission, readTenantRows } from "./tenant-departure-read";
import { normalizeTeamKeyVersion } from "./team-key-resolution";

/**
 * Server-side ItemKey identity and team-key holder rules
 * (docs/archive/review/team-key-rotation-rekey-plan.md C1).
 */

// One definition each, shared with the client (team-key-resolution.ts has no
// server imports).
export { isRekeyPending, itemKeyIdsMatch, normalizeTeamKeyVersion } from "./team-key-resolution";

/** The Prisma form of isRekeyPending, for the entries of one team. */
export function rekeyPendingWhere(teamKeyVersion: number): Prisma.TeamPasswordEntryWhereInput {
  return {
    OR: [
      { itemKeyTeamKeyVersion: { lt: teamKeyVersion } },
      { itemKeyVersion: { gte: 1 }, itemKeyId: null },
    ],
  };
}

/**
 * The version a new ItemKey of the entry takes. The high-water covers every
 * version this release wrote. An entry an instance of an older release created
 * or upgraded during the 0.5.0 rollout left it at 0; 20261120000000 raised it,
 * and the entry's own version stays in the max as a defensive floor.
 */
export function nextItemKeyVersion(highWater: number, itemKeyVersion: number): number {
  return Math.max(highWater, itemKeyVersion) + 1;
}

/**
 * A new ItemKey wrap whose IV equals the locked entry's wrap IV or any of the
 * entry's history wraps' (C1): random 96-bit IVs make that a client echoing a
 * snapshot back, not a collision. Shared by the v0→v1 upgrade PUT and the
 * re-key POST; MUST run under the entry's FOR UPDATE lock.
 */
export async function itemKeyIvReused(
  tx: Pick<Prisma.TransactionClient, "teamPasswordEntryHistory">,
  entryId: string,
  lockedItemKeyIv: string | null,
  newItemKeyIv: string,
): Promise<boolean> {
  const newIv = newItemKeyIv.toLowerCase();
  if (lockedItemKeyIv?.toLowerCase() === newIv) return true;
  const history = await tx.teamPasswordEntryHistory.findMany({
    where: { entryId },
    select: { itemKeyIv: true },
  });
  return history.some((h) => h.itemKeyIv?.toLowerCase() === newIv);
}

export type TeamKeyVersionHolder = { userId: string; role: TeamRole };

type HolderTx = Pick<
  Prisma.TransactionClient,
  "teamMemberKey" | "teamMember" | "tenantMember" | "tenantMemberDeparture"
>;

/**
 * Holders of team key version `version` (normalised): users with a
 * `team_member_keys` row at that version whose team membership is active and
 * who are not leftovers (left the tenant at or after their admission, see
 * actorDepartedSinceAdmission). Authoritative only under a lock that
 * membership removal and departure also take (the team row, see
 * team-key-rotation-lock.ts); `tx` is the team's own RLS context.
 */
export async function teamKeyVersionHolders(
  tx: HolderTx,
  tenantId: string,
  teamId: string,
  version: number,
): Promise<TeamKeyVersionHolder[]> {
  const keys = await tx.teamMemberKey.findMany({
    where: { teamId, keyVersion: normalizeTeamKeyVersion(version) },
    select: { userId: true },
  });
  if (keys.length === 0) return [];
  const members = await tx.teamMember.findMany({
    where: { teamId, userId: { in: keys.map((k) => k.userId) }, deactivatedAt: null },
    select: { userId: true, role: true, admittedAt: true, createdAt: true },
  });
  const tenantRows = await readTenantRows(tx, tenantId, members.map((m) => m.userId));
  return members
    .filter((m) => !actorDepartedSinceAdmission(tenantRows.get(m.userId), m.admittedAt ?? m.createdAt))
    .map((m) => ({ userId: m.userId, role: m.role }));
}

/**
 * Members holding a key at team key version `version` (normalised) who are
 * not holders but would hold the version again: a deactivated team membership
 * (tenant departure, IdP removal) or a leftover active one (see
 * teamKeyVersionHolders). Read in the team's own RLS context, like
 * teamKeyVersionHolders.
 */
export async function inactiveTeamKeyVersionHolderCount(
  tx: HolderTx,
  tenantId: string,
  teamId: string,
  version: number,
): Promise<number> {
  const keys = await tx.teamMemberKey.findMany({
    where: { teamId, keyVersion: normalizeTeamKeyVersion(version) },
    select: { userId: true },
  });
  if (keys.length === 0) return 0;
  const members = await tx.teamMember.findMany({
    where: { teamId, userId: { in: keys.map((k) => k.userId) } },
    select: { userId: true, deactivatedAt: true, admittedAt: true, createdAt: true },
  });
  const tenantRows = await readTenantRows(tx, tenantId, members.map((m) => m.userId));
  return members.filter(
    (m) =>
      m.deactivatedAt !== null ||
      actorDepartedSinceAdmission(tenantRows.get(m.userId), m.admittedAt ?? m.createdAt),
  ).length;
}

/** A holder who may re-key: their role carries TEAM_UPDATE. */
export function isRekeyerHolder(holder: TeamKeyVersionHolder): boolean {
  return hasTeamPermission(holder.role, TEAM_PERMISSION.TEAM_UPDATE);
}

/** Team key versions the user has a `team_member_keys` row for. */
export async function heldTeamKeyVersions(
  tx: Pick<Prisma.TransactionClient, "teamMemberKey">,
  teamId: string,
  userId: string,
): Promise<number[]> {
  const rows = await tx.teamMemberKey.findMany({
    where: { teamId, userId },
    select: { keyVersion: true },
    orderBy: { keyVersion: "asc" },
  });
  return rows.map((r) => r.keyVersion);
}
