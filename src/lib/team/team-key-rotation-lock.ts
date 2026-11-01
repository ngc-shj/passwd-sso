import type { Prisma } from "@prisma/client";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
import { readWaitTimeouts, restoreWaitTimeouts, setWaitTimeouts } from "@/lib/tenant-rls-grants";
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
const QUERY_CANCELED = "57014";
/**
 * Added to statement_timeout over the lock wait: statement_timeout also counts
 * planning and execution, so with only a few milliseconds of budget left it
 * would cancel a statement that never waits. Small against the transaction's
 * timeout (TEAM_MEMBERSHIP_TX_TIMEOUT_MS).
 */
const STATEMENT_SLACK_MS = 200;

/** A writer gave up waiting for an in-flight rotation of the team. */
export class TeamRotationInProgressError extends Error {
  constructor() {
    super("Team key rotation in progress");
    this.name = "TeamRotationInProgressError";
  }
}

/**
 * One lock-wait deadline shared by every bounded wait of a transaction. A
 * transaction that waits on a tenant row and then on a team row passes the
 * same budget to both, so the two waits together end inside
 * TEAM_KEY_LOCK_TIMEOUT_MS rather than each taking it in turn.
 */
export type LockBudget = { readonly deadline: number };

export function createLockBudget(totalMs: number = TEAM_KEY_LOCK_TIMEOUT_MS): LockBudget {
  return { deadline: Date.now() + totalMs };
}

/**
 * Run one locking statement with lock_timeout bounded to what is left of
 * `budget` (a fresh TEAM_KEY_LOCK_TIMEOUT_MS when none is passed), so a wait
 * ends before the caller's transaction (Prisma's 5s default) expires into a
 * bare 500; past it throws `timeoutError()` (TeamRotationInProgressError by
 * default). A spent budget throws before waiting: `lock_timeout = 0` would
 * mean no limit. The previous lock_timeout is restored afterwards, so the
 * caller's later statements wait as they did before. Both lock_timeout and
 * statement_timeout are bounded: the first applies per lock, the second to the
 * statement, so a statement taking N locks cannot wait N times the budget. (On a failure the
 * transaction is aborted, or rolled back to the caller's savepoint, which
 * reverts the setting itself.)
 */
export async function withBoundedLockWait<T>(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  lock: () => Promise<T>,
  options: { budget?: LockBudget; timeoutError?: () => Error } = {},
): Promise<T> {
  const timeoutError = options.timeoutError ?? (() => new TeamRotationInProgressError());
  const waitMs = options.budget
    ? Math.min(TEAM_KEY_LOCK_TIMEOUT_MS, options.budget.deadline - Date.now())
    : TEAM_KEY_LOCK_TIMEOUT_MS;
  if (waitMs < 1) throw timeoutError();
  // lock_timeout bounds each lock the statement acquires; statement_timeout
  // bounds the statement as a whole, which matters for one taking several
  // (all of a write's advisory locks, a multi-row FOR SHARE).
  const previous = await readWaitTimeouts(tx);
  await setWaitTimeouts(tx, Math.floor(waitMs), Math.floor(waitMs) + STATEMENT_SLACK_MS);
  let result: T;
  try {
    result = await lock();
  } catch (e) {
    const code = pgErrorCode(e);
    if (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED) throw timeoutError();
    throw e;
  }
  await restoreWaitTimeouts(tx, previous);
  return result;
}

/**
 * Read the team's current key version and tenant under `FOR SHARE`, held
 * until the transaction ends. Returns null when the team row is not
 * visible (deleted, or hidden by RLS) — callers treat that as a mismatch.
 * Throws TeamRotationInProgressError when a rotation holds the row past the
 * bounded wait.
 *
 * MUST run inside an open transaction; a bare client degrades it to an
 * unlocked read.
 */
export async function lockTeamKeyVersion(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  teamId: string,
): Promise<{ teamKeyVersion: number; tenantId: string } | null> {
  const [team] = await withBoundedLockWait(tx, () =>
    tx.$queryRaw<{ team_key_version: number; tenant_id: string }[]>`
      SELECT team_key_version, tenant_id FROM teams WHERE id = ${teamId}::uuid FOR SHARE
    `,
  );
  return team ? { teamKeyVersion: team.team_key_version, tenantId: team.tenant_id } : null;
}

/**
 * Team rows a membership change needed locked but that were not: hidden by
 * the transaction's RLS context, or joined after the lock was taken.
 * Refusing beats changing the membership unserialised.
 */
export class TeamRotationLockError extends Error {
  constructor(readonly missing: number) {
    super(`Could not lock ${missing} team row(s) against key rotation`);
    this.name = "TeamRotationLockError";
  }
}

async function lockTeamRows(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  teamIds: readonly string[],
  budget?: LockBudget,
): Promise<Set<string>> {
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) return new Set();
  const locked = await withBoundedLockWait(tx, () =>
    tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM teams WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR SHARE
    `,
    { budget },
  );
  return new Set(locked.map((row) => row.id));
}

/** Throw TeamRotationLockError unless every team in `teamIds` is in `locked`. */
export function assertTeamsLocked(locked: ReadonlySet<string>, teamIds: readonly string[]): void {
  const missing = new Set(teamIds.filter((id) => !locked.has(id))).size;
  if (missing > 0) throw new TeamRotationLockError(missing);
}

/**
 * `FOR SHARE` on the given team rows (id order, so two such writers cannot
 * deadlock each other), for a transaction that removes or deactivates a
 * member of those teams. Fails closed: a team row that cannot be locked
 * throws TeamRotationLockError.
 */
export async function lockTeamsAgainstRotation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  teamIds: readonly string[],
  budget?: LockBudget,
): Promise<void> {
  assertTeamsLocked(await lockTeamRows(tx, teamIds, budget), teamIds);
}

/** Ids of the teams the user is a member of (optionally within one tenant). */
export async function memberTeamIds(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
  tenantId?: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ team_id: string }[]>`
    SELECT DISTINCT team_id FROM team_members
     WHERE user_id = ${userId}::uuid AND (${tenantId ?? null}::uuid IS NULL OR tenant_id = ${tenantId ?? null}::uuid)
  `;
  return rows.map((row) => row.team_id);
}

/**
 * `FOR SHARE` on every team the user is currently a member of, for a
 * transaction that removes the user's memberships or member keys: a removal
 * that commits after a rotation read the member set would otherwise leave
 * the removed member a key to the new version. Run it before the
 * transaction's first users / team_members / team_member_keys lock.
 *
 * Returns the locked set. A team deleted meanwhile is simply absent. The
 * membership set read here can still grow before the caller's writes, so
 * the caller MUST check the teams it actually changed against the returned
 * set with assertTeamsLocked — after a lock that stops new memberships (the
 * user's `users` row FOR UPDATE), or on the rows its delete returned.
 */
export async function lockMemberTeamsAgainstRotation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  userId: string,
  tenantId?: string,
  budget?: LockBudget,
): Promise<Set<string>> {
  return lockTeamRows(tx, await memberTeamIds(tx, userId, tenantId), budget);
}

/**
 * The refusals a membership-changing transaction raises against rotation:
 * a wait past the bounded lock timeout, or a team it could not lock. Both
 * roll the transaction back and are safe to retry.
 */
export function isTeamRotationConflict(e: unknown): boolean {
  return e instanceof TeamRotationInProgressError || e instanceof TeamRotationLockError;
}
