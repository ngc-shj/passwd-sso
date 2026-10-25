/**
 * What the bootstrap migration (`claimedTenantMembership` in src/auth.ts, rows
 * 6 / 9a) does with each model, derived from `STRANDED_COUNTERS` — the
 * schema-derived set of models a user owns under a tenant
 * (`tenant-context.stranded-models.test.ts`) — and from the rest of the
 * schema's user-bound models (`user-bound-models.ts`).
 *
 * Every counter is either migrated, with its treatment, or named in
 * `NOT_MIGRATED` with a reason: `MIGRATED_COUNTERS` must name exactly the rest,
 * so a counter added to `STRANDED_COUNTERS` fails to compile here until it is
 * classified, and the integration seeders keyed by it fail to compile until
 * the new model has one. A user-bound model that is not a counter is either a
 * named non-counter write or in `TENANT_OWNED_LEFT` with a reason.
 * `src/auth.bootstrap-migration.test.ts` holds the migration's own writes to
 * the same sets.
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
  /** Left under the bootstrap tenant and revoked: `REVOKED_BY` names the column. */
  REVOKE: "revoke",
} as const;

export type MigrationTreatment = (typeof MIGRATION_TREATMENT)[keyof typeof MIGRATION_TREATMENT];

const { MOVE, REVOKE } = MIGRATION_TREATMENT;

export const MIGRATED_COUNTERS = {
  account: MOVE,
  apiKey: MOVE,
  attachment: MOVE,
  emergencyAccessGrant: MOVE,
  extensionToken: MOVE,
  folder: MOVE,
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
  // Authenticates as the user with the bootstrap tenant's maintenance scope.
  operatorToken: REVOKE,
  // The exchange does not re-check the passkey requirement, so a moved code
  // would mint a target-tenant token never held to the target's policy.
  extensionBridgeCode: REVOKE,
  mobileBridgeCode: REVOKE,
} as const satisfies Record<MigratedCounterHandle, MigrationTreatment>;

export type RevokedCounterHandle = {
  [K in keyof typeof MIGRATED_COUNTERS]: (typeof MIGRATED_COUNTERS)[K] extends typeof REVOKE ? K : never;
}[keyof typeof MIGRATED_COUNTERS];

/** The column a REVOKE counter's revocation sets: `revokedAt`, or `usedAt` for a single-use code. */
export const REVOKED_BY = {
  delegationSession: "revokedAt",
  mcpAccessToken: "revokedAt",
  mcpRefreshToken: "revokedAt",
  operatorToken: "revokedAt",
  mcpAuthorizationCode: "usedAt",
  extensionBridgeCode: "usedAt",
  mobileBridgeCode: "usedAt",
} as const satisfies Record<RevokedCounterHandle, "revokedAt" | "usedAt">;

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

/**
 * The user-bound models that are not counters (`NOT_STRANDED` in the
 * stranded-models test) and that the migration does not write, each with why.
 * A user-bound model must be a counter, a non-counter write, or named here.
 */
export const TENANT_OWNED_LEFT = {
  teamMember: "a team membership; teams are not migrated",
  teamPasswordEntry: "team-owned; teams are not migrated",
  teamPasswordEntryHistory: "team-owned; teams are not migrated",
  teamInvitation: "team-owned; teams are not migrated",
  scimToken: "tenant-owned credential; the user column is who minted it",
  serviceAccount: "tenant-owned identity; the user column is who created it",
  mcpClient: "tenant-owned OAuth client; the user column is who registered it",
  masterKeyRotation: "tenant-owned operation; every user column is provenance",
  adminVaultReset:
    "authorised by the bootstrap tenant's admins; executing it refuses while the target's vault rows are filed outside its tenant (findVaultRowsOutsideTenant), which the migration makes true",
  personalLogAccessGrant:
    "the bootstrap tenant's break-glass grant; the logs route refuses it once the target is not that tenant's active member (target_deactivated), which the membership delete makes true",
  accessRequest:
    "the composite FK (serviceAccountId, tenantId) pins it to its service account's tenant, and service accounts are not migrated",
} as const;
