/**
 * Emergency-access state machine — contract-first SSoT.
 *
 * C3 / S12: when called inside withBypassRls, the caller MUST supply at least
 * one of { ownerId | granteeId | granteeEmail | tokenHash } in `where`. Omitting
 * all of them would let a WHERE clause without an explicit per-resource predicate
 * match arbitrary rows under bypass scope. This module enforces that at runtime.
 *
 * S8 / prisma-proxy invariant: this module inherits the active transaction and
 * RLS context from the caller via the AsyncLocalStorage proxy in
 * src/lib/prisma.ts:145-174. Do NOT start a new $transaction here; pass `db: tx`
 * when already inside a transaction, or `db: prisma` otherwise.
 */
import type { EmergencyAccessStatus, Prisma } from "@prisma/client";
import type { TxOrPrisma } from "@/lib/prisma";
import { EA_STATUS, EA_ACTOR, type EaActor } from "@/lib/constants";
import { isBypassRlsActive } from "@/lib/tenant-rls";

export { EA_ACTOR, type EaActor };

/**
 * Exhaustive transition matrix. Empty array = forbidden transition.
 * Adding a new EmergencyAccessStatus value produces a compile error here (C1).
 */
export const MATRIX: Record<
  EmergencyAccessStatus,
  Record<EmergencyAccessStatus, ReadonlyArray<EaActor>>
> = {
  [EA_STATUS.PENDING]: {
    [EA_STATUS.ACCEPTED]: [EA_ACTOR.GRANTEE],
    [EA_STATUS.REJECTED]: [EA_ACTOR.GRANTEE],
    [EA_STATUS.REVOKED]: [EA_ACTOR.OWNER],
    [EA_STATUS.IDLE]: [],
    [EA_STATUS.STALE]: [],
    [EA_STATUS.REQUESTED]: [],
    [EA_STATUS.ACTIVATED]: [],
    [EA_STATUS.PENDING]: [],
  },
  [EA_STATUS.ACCEPTED]: {
    [EA_STATUS.IDLE]: [EA_ACTOR.OWNER],
    [EA_STATUS.REVOKED]: [EA_ACTOR.OWNER],
    [EA_STATUS.PENDING]: [],
    [EA_STATUS.ACCEPTED]: [],
    [EA_STATUS.REJECTED]: [],
    [EA_STATUS.STALE]: [],
    [EA_STATUS.REQUESTED]: [],
    [EA_STATUS.ACTIVATED]: [],
  },
  [EA_STATUS.IDLE]: {
    [EA_STATUS.REQUESTED]: [EA_ACTOR.GRANTEE],
    [EA_STATUS.STALE]: [EA_ACTOR.SYSTEM],
    [EA_STATUS.REVOKED]: [EA_ACTOR.OWNER],
    [EA_STATUS.PENDING]: [],
    [EA_STATUS.ACCEPTED]: [],
    [EA_STATUS.REJECTED]: [],
    [EA_STATUS.ACTIVATED]: [],
    [EA_STATUS.IDLE]: [],
  },
  [EA_STATUS.STALE]: {
    [EA_STATUS.IDLE]: [EA_ACTOR.OWNER],
    [EA_STATUS.REVOKED]: [EA_ACTOR.OWNER],
    [EA_STATUS.PENDING]: [],
    [EA_STATUS.ACCEPTED]: [],
    [EA_STATUS.REJECTED]: [],
    [EA_STATUS.REQUESTED]: [],
    [EA_STATUS.ACTIVATED]: [],
    [EA_STATUS.STALE]: [],
  },
  // PR #433/S1 invariant: REQUESTED → STALE (SYSTEM) must remain.
  // Removing this row allows an in-flight grantee to wait out waitExpiresAt
  // and unwrap the owner's pre-rotation secretKey via the stale escrow.
  [EA_STATUS.REQUESTED]: {
    [EA_STATUS.ACTIVATED]: [EA_ACTOR.OWNER, EA_ACTOR.SYSTEM],
    [EA_STATUS.IDLE]: [EA_ACTOR.OWNER],
    [EA_STATUS.STALE]: [EA_ACTOR.SYSTEM],
    [EA_STATUS.REVOKED]: [EA_ACTOR.OWNER],
    [EA_STATUS.PENDING]: [],
    [EA_STATUS.ACCEPTED]: [],
    [EA_STATUS.REJECTED]: [],
    [EA_STATUS.REQUESTED]: [],
  },
  [EA_STATUS.ACTIVATED]: {
    [EA_STATUS.STALE]: [EA_ACTOR.SYSTEM],
    [EA_STATUS.REVOKED]: [EA_ACTOR.OWNER],
    [EA_STATUS.PENDING]: [],
    [EA_STATUS.ACCEPTED]: [],
    [EA_STATUS.REJECTED]: [],
    [EA_STATUS.IDLE]: [],
    [EA_STATUS.REQUESTED]: [],
    [EA_STATUS.ACTIVATED]: [],
  },
  [EA_STATUS.REVOKED]: {
    [EA_STATUS.PENDING]: [],
    [EA_STATUS.ACCEPTED]: [],
    [EA_STATUS.REJECTED]: [],
    [EA_STATUS.IDLE]: [],
    [EA_STATUS.STALE]: [],
    [EA_STATUS.REQUESTED]: [],
    [EA_STATUS.ACTIVATED]: [],
    [EA_STATUS.REVOKED]: [],
  },
  [EA_STATUS.REJECTED]: {
    [EA_STATUS.PENDING]: [],
    [EA_STATUS.ACCEPTED]: [],
    [EA_STATUS.REJECTED]: [],
    [EA_STATUS.IDLE]: [],
    [EA_STATUS.STALE]: [],
    [EA_STATUS.REQUESTED]: [],
    [EA_STATUS.ACTIVATED]: [],
    [EA_STATUS.REVOKED]: [],
  },
};

// Exhaustiveness assertion: compile error if a new EmergencyAccessStatus is added
// without updating MATRIX (C1).
const _exhaust: Record<
  EmergencyAccessStatus,
  Record<EmergencyAccessStatus, ReadonlyArray<EaActor>>
> = MATRIX;
void _exhaust;

export function canTransition(
  from: EmergencyAccessStatus,
  to: EmergencyAccessStatus,
  actor: EaActor,
): boolean {
  return MATRIX[from][to].includes(actor);
}

function hasResourceScope(where: Prisma.EmergencyAccessGrantWhereInput): boolean {
  return (
    where.ownerId !== undefined ||
    where.granteeId !== undefined ||
    where.granteeEmail !== undefined ||
    where.tokenHash !== undefined
  );
}

/**
 * Atomically transition a single grant row. Returns `{ ok: true }` if exactly
 * one row was updated, `{ ok: false }` if the transition was not permitted or
 * the row was not in an eligible from-state.
 *
 * C4: does NOT start a transaction or change RLS context — inherits from caller.
 * C5: does NOT emit audit events — caller is responsible for that.
 */
export async function transition(args: {
  db: TxOrPrisma;
  where: Prisma.EmergencyAccessGrantWhereInput;
  to: EmergencyAccessStatus;
  actor: EaActor;
  // UncheckedUpdateManyInput allows scalar FK fields (granteeId, ownerId, etc.)
  // directly, matching the data shape accepted by emergencyAccessGrant.updateMany().
  extraData?: Omit<Prisma.EmergencyAccessGrantUncheckedUpdateManyInput, "status">;
}): Promise<{ ok: true } | { ok: false }> {
  const allowedFroms = (
    Object.entries(MATRIX) as [
      EmergencyAccessStatus,
      Record<EmergencyAccessStatus, ReadonlyArray<EaActor>>,
    ][]
  )
    .filter(([_from, perms]) => perms[args.to].includes(args.actor))
    .map(([from]) => from);

  if (allowedFroms.length === 0) return { ok: false };

  // C3: under withBypassRls, require an explicit per-resource scope predicate.
  if (isBypassRlsActive() && !hasResourceScope(args.where)) {
    throw new Error(
      "transition: under withBypassRls, where must include one of " +
        "{ ownerId | granteeId | granteeEmail | tokenHash }",
    );
  }

  const result = await args.db.emergencyAccessGrant.updateMany({
    where: { ...args.where, status: { in: allowedFroms } },
    data: { ...args.extraData, status: args.to },
  });
  if (result.count > 1) {
    throw new Error(
      "transition: where matched >1 row; pass a unique-id predicate or use bulkTransition",
    );
  }
  return result.count === 1 ? { ok: true } : { ok: false };
}

/**
 * Atomically transition multiple grant rows matching `where`. Returns the count
 * of updated rows. Intended for bulk operations (vault key rotation, vault reset).
 *
 * C4: does NOT start a transaction or change RLS context — inherits from caller.
 * C5: does NOT emit audit events — caller is responsible for that.
 */
export async function bulkTransition(args: {
  db: TxOrPrisma;
  where: Prisma.EmergencyAccessGrantWhereInput;
  to: EmergencyAccessStatus;
  actor: EaActor;
  // UncheckedUpdateManyInput allows scalar FK fields directly.
  extraData?: Omit<Prisma.EmergencyAccessGrantUncheckedUpdateManyInput, "status">;
}): Promise<{ updated: number }> {
  const allowedFroms = (
    Object.entries(MATRIX) as [
      EmergencyAccessStatus,
      Record<EmergencyAccessStatus, ReadonlyArray<EaActor>>,
    ][]
  )
    .filter(([_from, perms]) => perms[args.to].includes(args.actor))
    .map(([from]) => from);

  if (allowedFroms.length === 0) return { updated: 0 };

  // C3: under withBypassRls, require an explicit per-resource scope predicate.
  if (isBypassRlsActive() && !hasResourceScope(args.where)) {
    throw new Error(
      "transition: under withBypassRls, where must include one of " +
        "{ ownerId | granteeId | granteeEmail | tokenHash }",
    );
  }

  const result = await args.db.emergencyAccessGrant.updateMany({
    where: { ...args.where, status: { in: allowedFroms } },
    data: { ...args.extraData, status: args.to },
  });
  return { updated: result.count };
}
