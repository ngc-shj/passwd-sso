/**
 * The owning-tenant adjudicator itself: which tenant a user's records belong to,
 * given their `User.tenantId` column and their ACTIVE memberships, oldest first.
 *
 * In its own module, with NO Prisma import — not even a type-only one — so the
 * offline operator CLI (`scripts/tenant-domain.ts backfill-owning-column`,
 * C4/#838) can call the SAME rule `resolveOwningTenantIdFromClient` uses without
 * reaching the application's Prisma singleton, which throws at import without
 * `DATABASE_URL` (round-7 F-R7-2's constraint, applied here to the rule itself
 * rather than only to its callers so far). Moved out of `tenant-context.ts`,
 * which imports it back (R48: one rule, two callers, neither able to answer the
 * same user differently). It was module-private there, so no other importer's
 * path changes.
 *
 * Total, not a wrapper over a producer's precondition:
 * `activeMembershipsOldestFirst` may be empty (falls back to the column), hold
 * one (that membership wins), or hold several (the oldest wins — a multi-active
 * user is decided by this rule, the same as every other caller of it, rather
 * than refused).
 */
export function owningTenantOf(
  column: string,
  activeMembershipsOldestFirst: readonly { tenantId: string }[],
): string {
  return activeMembershipsOldestFirst[0]?.tenantId ?? column;
}
