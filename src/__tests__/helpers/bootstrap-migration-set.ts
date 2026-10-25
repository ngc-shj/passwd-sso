/**
 * What the bootstrap migration (`claimedTenantMembership` in src/auth.ts, rows
 * 6 / 9a) does with each model, derived from `STRANDED_COUNTERS` — the
 * schema-derived set of models a user owns under a tenant
 * (`tenant-context.stranded-models.test.ts`).
 *
 * Every counter is either migrated, with its treatment, or named in
 * `NOT_MIGRATED` with a reason: `MIGRATED_COUNTERS` must name exactly the rest,
 * so a counter added to `STRANDED_COUNTERS` fails to compile here until it is
 * classified, and the integration seeders keyed by it fail to compile until
 * the new model has one. `bootstrap-migration-set.test.ts` holds the
 * migration's own writes to the same set.
 */
import { STRANDED_COUNTERS } from "@/lib/tenant/stranded-rows";

export type StrandedHandle = keyof typeof STRANDED_COUNTERS;

/** Counters the migration leaves where they are, each with why. */
export const NOT_MIGRATED = {
  teamMemberKey:
    "filed under its team's tenant (confirm-key and rotate-key write team.tenantId); teams and team memberships are not migrated",
  teamPasswordFavorite:
    "filed under the team entry's tenant (the favorite route writes entry.tenantId); team entries are not migrated",
} as const satisfies Partial<Record<StrandedHandle, string>>;

export type MigratedCounterHandle = Exclude<StrandedHandle, keyof typeof NOT_MIGRATED>;

export const MIGRATION_TREATMENT = {
  /** `tenantId` rewritten to the target tenant. */
  MOVE: "move",
  /** Left under the bootstrap tenant and revoked (`revokedAt`, or `usedAt` for a code). */
  REVOKE: "revoke",
} as const;

export type MigrationTreatment = (typeof MIGRATION_TREATMENT)[keyof typeof MIGRATION_TREATMENT];

const { MOVE, REVOKE } = MIGRATION_TREATMENT;

export const MIGRATED_COUNTERS = {
  account: MOVE,
  apiKey: MOVE,
  attachment: MOVE,
  emergencyAccessGrant: MOVE,
  extensionBridgeCode: MOVE,
  extensionToken: MOVE,
  folder: MOVE,
  mobileBridgeCode: MOVE,
  notification: MOVE,
  passwordEntry: MOVE,
  passwordShare: MOVE,
  session: MOVE,
  tag: MOVE,
  vaultKey: MOVE,
  webAuthnCredential: MOVE,
  // Bound to their MCP client's tenant, which is tenant-owned and stays.
  delegationSession: REVOKE,
  mcpAccessToken: REVOKE,
  mcpAuthorizationCode: REVOKE,
  mcpRefreshToken: REVOKE,
} as const satisfies Record<MigratedCounterHandle, MigrationTreatment>;

/**
 * The migration's writes that are not counters: the user row itself, the
 * three models it moves by tenant alone (no user column; a bootstrap tenant
 * has one member), the audit trail (moved by the `audit_log_tenant_migrate`
 * procedure, since `audit_logs` UPDATE is revoked from the app role), and the
 * membership it replaces.
 */
export const NON_COUNTER_WRITES = {
  user: "the user's own tenant column",
  passwordEntryHistory: "moved by tenant alone; reached through its entry",
  emergencyAccessKeyPair: "moved by tenant alone; reached through its grant",
  shareAccessLog: "moved by tenant alone; reached through its share",
  auditLog: "moved by CALL audit_log_tenant_migrate",
  tenantMember: "the bootstrap membership deleted, the target membership created",
} as const;

export type NonCounterWriteHandle = keyof typeof NON_COUNTER_WRITES;
