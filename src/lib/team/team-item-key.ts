import type { Prisma, TeamRole } from "@prisma/client";
import { hasTeamPermission } from "@/lib/auth/access/team-auth";
import { TEAM_PERMISSION } from "@/lib/constants";

/**
 * Server-side ItemKey identity and team-key holder rules
 * (docs/archive/review/team-key-rotation-rekey-plan.md C1).
 */

/**
 * The single comparison of two ItemKey ids. NULL never matches — not even
 * NULL against NULL: an unknown ItemKey is never "the same" as another one.
 */
export function itemKeyIdsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  return a.toLowerCase() === b.toLowerCase();
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

/** Team key versions below 1 are version 1 everywhere (as clients treat them). */
export function normalizeTeamKeyVersion(version: number): number {
  return version < 1 ? 1 : version;
}

export type TeamKeyVersionHolder = { userId: string; role: TeamRole };

/**
 * Holders of team key version `version` (normalised): users with a
 * `team_member_keys` row at that version whose team membership is active.
 * Authoritative only under a lock that membership removal and departure
 * also take (the team row, see team-key-rotation-lock.ts).
 */
export async function teamKeyVersionHolders(
  tx: Pick<Prisma.TransactionClient, "teamMemberKey" | "teamMember">,
  teamId: string,
  version: number,
): Promise<TeamKeyVersionHolder[]> {
  const keys = await tx.teamMemberKey.findMany({
    where: { teamId, keyVersion: normalizeTeamKeyVersion(version) },
    select: { userId: true },
  });
  if (keys.length === 0) return [];
  return tx.teamMember.findMany({
    where: { teamId, userId: { in: keys.map((k) => k.userId) }, deactivatedAt: null },
    select: { userId: true, role: true },
  });
}

/**
 * Members holding a key at team key version `version` (normalised) whose
 * team membership is deactivated (tenant departure, IdP removal): not
 * holders, but they would hold the version again if reactivated. Read in the
 * team's own RLS context, like teamKeyVersionHolders.
 */
export async function deactivatedTeamKeyVersionHolderCount(
  tx: Pick<Prisma.TransactionClient, "teamMemberKey" | "teamMember">,
  teamId: string,
  version: number,
): Promise<number> {
  const keys = await tx.teamMemberKey.findMany({
    where: { teamId, keyVersion: normalizeTeamKeyVersion(version) },
    select: { userId: true },
  });
  if (keys.length === 0) return 0;
  return tx.teamMember.count({
    where: { teamId, userId: { in: keys.map((k) => k.userId) }, deactivatedAt: { not: null } },
  });
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
