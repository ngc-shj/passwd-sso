import type { TxOrPrisma } from "@/lib/prisma";

/**
 * The four routing operations recorded in `tenant_claim_events` (SC11 / #743).
 *
 * A const-object plus a derived union rather than a bare string union: the
 * repo's standing convention for an enumerated set of three or more literals,
 * and the shape `AUDIT_ACTION` / `TENANT_ROLE` already use.
 *
 * `tenant_claim_events_operation_check` in
 * `prisma/migrations/20260731100000_add_tenant_claim_events/migration.sql`
 * carries the same four values. The two are pinned against each other by a
 * drift test that reads `pg_get_constraintdef` from the LIVE catalogue — not
 * from the migration file, which is immutable once applied and therefore says
 * nothing about what the database currently enforces.
 *
 * NOT a partition of outcomes. `tenant-domain add --from` against a revoked
 * row is simultaneously a reassignment and an un-revoke, and is recorded as
 * `reassign`. Revocation-state questions are answered from
 * `oldRevokedAt`/`newRevokedAt`, never by filtering on `operation`.
 */
export const TENANT_CLAIM_EVENT_OPERATION = {
  REGISTER: "register",
  REVOKE: "revoke",
  UNREVOKE: "unrevoke",
  REASSIGN: "reassign",
} as const;

export type TenantClaimEventOperation =
  (typeof TENANT_CLAIM_EVENT_OPERATION)[keyof typeof TENANT_CLAIM_EVENT_OPERATION];

/** The label the sign-in auto-registration path records as its actor. */
export const SIGNIN_ACTOR_LABEL = "signin";

export type TenantClaimEventInput = {
  claim: string;
  operation: TenantClaimEventOperation;
  /** The tenant the claim resolved to before this change; null on first registration. */
  oldTenantId: string | null;
  /** The tenant it resolves to after; null only if a future operation stops resolving. */
  newTenantId: string | null;
  oldRevokedAt: Date | null;
  newRevokedAt: Date | null;
  /** Self-asserted operator label (`--by`), or `SIGNIN_ACTOR_LABEL`. */
  actorLabel: string;
};

/**
 * Append one routing-history row, in the caller's transaction.
 *
 * `db` MUST be a transaction client. Nothing proves it: the type cannot
 * (`Prisma.TransactionClient` is `Omit<PrismaClient, ITXClientDenyList>`, which
 * a `PrismaClient` satisfies structurally), and the completeness gate proves
 * only that an event is emitted in the same function — necessary, not
 * sufficient. What the gate does add is a tripwire on the direct spelling
 * `recordTenantClaimEvent(prisma, …)`; an aliased binding passes it. So the
 * requirement is held by the callers, and the two mechanisms above narrow the
 * ways it can be lost rather than closing them. An event that commits
 * independently of its mutation is the durability gap this table exists to
 * close, so a new call site is worth reading for this specifically.
 *
 * Raw INSERT, and specifically one with **no RETURNING**: `passwd_app` holds
 * INSERT and nothing else, and `RETURNING` requires SELECT on the returned
 * columns, so a Prisma `create()` — which always returns the row — would fail
 * at run time on the sign-in path and pass every mocked test. `createMany()`
 * would be privilege-compatible; it is excluded by the one-producer rule, not
 * by privilege.
 *
 * `db_user`, `session_db_user`, `client_addr` and `created_at` are deliberately
 * absent from this statement: a BEFORE INSERT trigger assigns them, discarding
 * anything a caller supplies. That is what makes them attribution rather than
 * decoration.
 */
export async function recordTenantClaimEvent(
  db: TxOrPrisma,
  event: TenantClaimEventInput,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO tenant_claim_events
      (id, claim, operation, old_tenant_id, new_tenant_id,
       old_revoked_at, new_revoked_at, actor_label)
    VALUES
      (gen_random_uuid(), ${event.claim}, ${event.operation},
       ${event.oldTenantId}::uuid, ${event.newTenantId}::uuid,
       ${event.oldRevokedAt}::timestamptz, ${event.newRevokedAt}::timestamptz,
       ${event.actorLabel})
  `;
}
