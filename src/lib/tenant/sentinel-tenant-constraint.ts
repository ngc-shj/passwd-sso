/**
 * Recognising the engine's refusal of a sentinel-pointing tenant id.
 *
 * Three CHECK constraints keep `SYSTEM_TENANT_ID` out of the tables a sign-in
 * writes. When a `tenant_claims` row points at the sentinel — a state no
 * operator command can create, since `tenant-domain add` refuses a sentinel
 * target on the resolved id — the claim resolves, the write is attempted, and
 * one of them raises. Without this reader the throw reaches Auth.js as an
 * opaque adapter error: the sign-in denies either way, but the denial is
 * recorded as `provider_error` and `tenant-domain unmapped` cannot print it,
 * which is the observability half CF13 exists to close.
 *
 * Which one fires depends on the path, and the difference is load-bearing
 * because the emit is written at whichever site catches:
 *
 *   first-ever sign-in      `users_not_system_tenant`
 *                           (auth-adapter's `user.create` precedes its
 *                           `tenantMember.create`, so the users CHECK is first)
 *   returning, no member    `tenant_members_not_system_tenant`
 *   tenant migration        `users_not_system_tenant` (`user.update`)
 *
 * `teams_not_system_tenant` is in the set defensively. No sign-in path writes a
 * `teams` row, so that member is unfalsifiable from the application — it is here
 * because the set is "the sentinel CHECKs", not "the ones a sign-in has been
 * observed to hit", and a member added later must not have to be discovered.
 *
 * Matched by exact `Set.has` on an EXTRACTED name, never by a substring search
 * of the message: a message that merely mentions a constraint (a trigger
 * quoting one, a detail line) would satisfy a substring test, and a substring
 * test cannot report the name it was not looking for.
 */

import {
  pgConstraintName,
  pgErrorCode,
  SQLSTATE_CHECK_VIOLATION,
} from "@/lib/prisma/prisma-error";

/**
 * Names, spelled as the migrations spell them:
 *   20260901090000_forbid_system_tenant_membership     tenant_members
 *   20260904120000_forbid_system_tenant_on_users_and_teams  users, teams
 *
 * The tie to those files is checked by execution rather than by grep —
 * `src/__tests__/db-integration/audit-unattributable-tenant.integration.test.ts`
 * reads `pg_constraint` and reds if a name here names nothing.
 */
export const SENTINEL_TENANT_CONSTRAINTS: ReadonlySet<string> = new Set([
  "users_not_system_tenant",
  "teams_not_system_tenant",
  "tenant_members_not_system_tenant",
]);

/** What `classifySentinelTenantConstraint` decided about an error. */
export type SentinelTenantConstraintVerdict =
  /** A sentinel CHECK refused the write, and this is which one. */
  | { kind: "sentinel"; constraint: string }
  /**
   * A check violation whose constraint could not be read at all. Its own arm
   * rather than folded into `other`: the reachable cause is a PostgreSQL server
   * with a non-English `lc_messages`, where the name is present but unparseable,
   * and an operator debugging a denied sign-in needs to be told that rather than
   * shown "some other constraint".
   */
  | { kind: "unnamed_check" }
  /** Anything else — a different constraint, or not a check violation at all. */
  | { kind: "other" };

export function classifySentinelTenantConstraint(
  err: unknown,
): SentinelTenantConstraintVerdict {
  if (pgErrorCode(err) !== SQLSTATE_CHECK_VIOLATION) return { kind: "other" };
  const constraint = pgConstraintName(err);
  if (constraint === null) return { kind: "unnamed_check" };
  return SENTINEL_TENANT_CONSTRAINTS.has(constraint)
    ? { kind: "sentinel", constraint }
    : { kind: "other" };
}
