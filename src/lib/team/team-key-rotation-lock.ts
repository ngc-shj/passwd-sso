import type { Prisma } from "@prisma/client";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
import { setLockTimeout } from "@/lib/tenant-rls-grants";
import { TEAM_KEY_LOCK_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";

/**
 * Team key rotation reads two inputs — the team's entries and its
 * key-holding members — and writes the next team key version. Every
 * transaction that changes either input serialises with it through the
 * team row: rotation takes `teams ... FOR NO KEY UPDATE` as its first
 * statement, and the writers below take `teams ... FOR SHARE` before
 * touching entries, member keys or member rows. Under READ COMMITTED a
 * writer then either commits before rotation reads its inputs (and is
 * read), or waits and runs against the committed rotation.
 *
 * Lock order: `teams` before `users`, `team_members`, `team_member_keys`
 * and `team_password_entries` — rotation's own member-key insert takes
 * KEY SHARE on `users`, so a writer holding a `users` lock while waiting
 * for `teams` would close a deadlock cycle.
 */

const LOCK_NOT_AVAILABLE = "55P03";

/** A writer gave up waiting for an in-flight rotation of the team. */
export class TeamRotationInProgressError extends Error {
  constructor() {
    super("Team key rotation in progress");
    this.name = "TeamRotationInProgressError";
  }
}

/**
 * Read the team's current key version and tenant under `FOR SHARE`, held
 * until the transaction ends. Returns null when the team row is not
 * visible (deleted, or hidden by RLS) — callers treat that as a mismatch.
 *
 * Waits at most TEAM_KEY_LOCK_TIMEOUT_MS for an in-flight rotation, so the
 * caller's transaction (Prisma's 5s default) does not expire first and
 * surface as a bare 500; past it throws TeamRotationInProgressError. The
 * lock_timeout stays set for the rest of the transaction.
 *
 * MUST run inside an open transaction; a bare client degrades it to an
 * unlocked read.
 */
export async function lockTeamKeyVersion(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  teamId: string,
): Promise<{ teamKeyVersion: number; tenantId: string } | null> {
  await setLockTimeout(tx, TEAM_KEY_LOCK_TIMEOUT_MS);
  let rows: { team_key_version: number; tenant_id: string }[];
  try {
    rows = await tx.$queryRaw<{ team_key_version: number; tenant_id: string }[]>`
      SELECT team_key_version, tenant_id FROM teams WHERE id = ${teamId}::uuid FOR SHARE
    `;
  } catch (e) {
    if (pgErrorCode(e) === LOCK_NOT_AVAILABLE) throw new TeamRotationInProgressError();
    throw e;
  }
  const [team] = rows;
  return team ? { teamKeyVersion: team.team_key_version, tenantId: team.tenant_id } : null;
}

/**
 * The team rows a member-removal lock expected but could not lock: hidden by
 * the transaction's RLS context or deleted meanwhile. Refusing beats
 * removing the member unserialised.
 */
export class TeamRotationLockError extends Error {
  constructor(readonly missing: number) {
    super(`Could not lock ${missing} team row(s) against key rotation`);
    this.name = "TeamRotationLockError";
  }
}

/**
 * `FOR SHARE` on every team the user is a member of (optionally within one
 * tenant), in id order so two such writers cannot deadlock each other. For
 * transactions that remove or deactivate a member, or delete member keys:
 * a removal that commits after rotation read the member set would otherwise
 * leave the removed member a key to the new version. Run it before the
 * transaction's first users / team_members / team_member_keys lock.
 *
 * Fails closed: the teams are derived from the visible membership rows, and
 * fewer locked rows than memberships throws TeamRotationLockError — a
 * context whose RLS grant hides `teams` would otherwise lock nothing.
 */
export async function lockMemberTeamsAgainstRotation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
  tenantId?: string,
): Promise<void> {
  const memberships = tenantId === undefined
    ? await tx.$queryRaw<{ team_id: string }[]>`
        SELECT DISTINCT team_id FROM team_members WHERE user_id = ${userId}::uuid`
    : await tx.$queryRaw<{ team_id: string }[]>`
        SELECT DISTINCT team_id FROM team_members
         WHERE user_id = ${userId}::uuid AND tenant_id = ${tenantId}::uuid`;
  await lockTeamsAgainstRotation(tx, memberships.map((m) => m.team_id));
}

/** `FOR SHARE` on the given team rows; see lockMemberTeamsAgainstRotation. */
export async function lockTeamsAgainstRotation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  teamIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) return;
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM teams WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR SHARE
  `;
  if (locked.length !== ids.length) throw new TeamRotationLockError(ids.length - locked.length);
}
