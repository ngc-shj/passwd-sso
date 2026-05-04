/**
 * Access-request state machine — contract-first SSoT.
 *
 * C3 / S12: when called inside withBypassRls, the caller MUST supply at least
 * one of { id | tenantId } in `where`. Access-request routes run inside
 * withTenantRls (not withBypassRls), so this check is defensive.
 *
 * S8 / prisma-proxy invariant: this module inherits the active transaction and
 * RLS context from the caller via the AsyncLocalStorage proxy in
 * src/lib/prisma.ts:145-174. Do NOT start a new $transaction here; pass `db: tx`
 * when already inside a transaction, or `db: prisma` otherwise.
 */
import type { AccessRequestStatus, Prisma } from "@prisma/client";
import type { TxOrPrisma } from "@/lib/prisma";
import { isBypassRlsActive } from "@/lib/tenant-rls";

export const AR_ACTOR = {
  ADMIN: "ADMIN",
  SYSTEM: "SYSTEM",
} as const;

export type ArActor = (typeof AR_ACTOR)[keyof typeof AR_ACTOR];

export const AR_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  EXPIRED: "EXPIRED",
} as const satisfies Record<AccessRequestStatus, AccessRequestStatus>;

/**
 * Exhaustive transition matrix. Empty array = forbidden transition.
 * Adding a new AccessRequestStatus value produces a compile error here (C1).
 */
export const MATRIX: Record<
  AccessRequestStatus,
  Record<AccessRequestStatus, ReadonlyArray<ArActor>>
> = {
  [AR_STATUS.PENDING]: {
    [AR_STATUS.APPROVED]: ["ADMIN"],
    [AR_STATUS.DENIED]: ["ADMIN"],
    // TODO(centralize-state-transitions-followup): no caller transitions to EXPIRED yet — implement cron in a follow-up PR
    [AR_STATUS.EXPIRED]: ["SYSTEM"],
    [AR_STATUS.PENDING]: [],
  },
  [AR_STATUS.APPROVED]: {
    [AR_STATUS.PENDING]: [],
    [AR_STATUS.APPROVED]: [],
    [AR_STATUS.DENIED]: [],
    [AR_STATUS.EXPIRED]: [],
  },
  [AR_STATUS.DENIED]: {
    [AR_STATUS.PENDING]: [],
    [AR_STATUS.APPROVED]: [],
    [AR_STATUS.DENIED]: [],
    [AR_STATUS.EXPIRED]: [],
  },
  [AR_STATUS.EXPIRED]: {
    [AR_STATUS.PENDING]: [],
    [AR_STATUS.APPROVED]: [],
    [AR_STATUS.DENIED]: [],
    [AR_STATUS.EXPIRED]: [],
  },
};

// Exhaustiveness assertion: compile error if a new AccessRequestStatus is added
// without updating MATRIX (C1).
const _exhaust: Record<
  AccessRequestStatus,
  Record<AccessRequestStatus, ReadonlyArray<ArActor>>
> = MATRIX;
void _exhaust;

export function canTransition(
  from: AccessRequestStatus,
  to: AccessRequestStatus,
  actor: ArActor,
): boolean {
  return MATRIX[from][to].includes(actor);
}

function hasScopeUnderBypass(where: Prisma.AccessRequestWhereInput): boolean {
  // Round-2 S3 fix: require an explicit tenantId predicate under withBypassRls.
  // `id` alone is insufficient — UUIDs are unguessable so the residual risk is
  // theoretical, but the predicate is the primary cross-tenant defense in
  // bypass scope and must mirror EA's per-resource-scope discipline.
  return where.tenantId !== undefined;
}

/**
 * Atomically transition a single access-request row. Returns `{ ok: true }` if
 * exactly one row was updated, `{ ok: false }` otherwise.
 *
 * C4: does NOT start a transaction or change RLS context — inherits from caller.
 * C5: does NOT emit audit events — caller is responsible for that.
 */
export async function transition(args: {
  db: TxOrPrisma;
  where: Prisma.AccessRequestWhereInput;
  to: AccessRequestStatus;
  actor: ArActor;
  // UncheckedUpdateManyInput allows scalar FK fields (approvedById, etc.)
  // directly, matching the data shape accepted by accessRequest.updateMany().
  extraData?: Omit<Prisma.AccessRequestUncheckedUpdateManyInput, "status">;
}): Promise<{ ok: true } | { ok: false }> {
  const allowedFroms = (
    Object.entries(MATRIX) as [
      AccessRequestStatus,
      Record<AccessRequestStatus, ReadonlyArray<ArActor>>,
    ][]
  )
    .filter(([_from, perms]) => perms[args.to].includes(args.actor))
    .map(([from]) => from);

  if (allowedFroms.length === 0) return { ok: false };

  // C3: under withBypassRls, require an explicit per-resource scope predicate.
  if (isBypassRlsActive() && !hasScopeUnderBypass(args.where)) {
    throw new Error(
      "transition: under withBypassRls, where must include one of { id | tenantId }",
    );
  }

  const result = await args.db.accessRequest.updateMany({
    where: { ...args.where, status: { in: allowedFroms } },
    data: { ...args.extraData, status: args.to },
  });
  return result.count >= 1 ? { ok: true } : { ok: false };
}

/**
 * Atomically transition multiple access-request rows matching `where`. Returns
 * the count of updated rows.
 *
 * C4: does NOT start a transaction or change RLS context — inherits from caller.
 * C5: does NOT emit audit events — caller is responsible for that.
 */
export async function bulkTransition(args: {
  db: TxOrPrisma;
  where: Prisma.AccessRequestWhereInput;
  to: AccessRequestStatus;
  actor: ArActor;
  // UncheckedUpdateManyInput allows scalar FK fields directly.
  extraData?: Omit<Prisma.AccessRequestUncheckedUpdateManyInput, "status">;
}): Promise<{ updated: number }> {
  const allowedFroms = (
    Object.entries(MATRIX) as [
      AccessRequestStatus,
      Record<AccessRequestStatus, ReadonlyArray<ArActor>>,
    ][]
  )
    .filter(([_from, perms]) => perms[args.to].includes(args.actor))
    .map(([from]) => from);

  if (allowedFroms.length === 0) return { updated: 0 };

  // C3: under withBypassRls, require an explicit per-resource scope predicate.
  if (isBypassRlsActive() && !hasScopeUnderBypass(args.where)) {
    throw new Error(
      "transition: under withBypassRls, where must include one of { id | tenantId }",
    );
  }

  const result = await args.db.accessRequest.updateMany({
    where: { ...args.where, status: { in: allowedFroms } },
    data: { ...args.extraData, status: args.to },
  });
  return { updated: result.count };
}
