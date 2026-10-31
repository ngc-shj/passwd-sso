import type { Prisma } from "@prisma/client";
import { NIL_UUID } from "@/lib/constants/app";
import { BYPASS_PURPOSE, type BypassPurpose } from "@/lib/tenant-rls-purpose";

/**
 * Prisma model → PostgreSQL table, mirroring each model's `@@map`. A literal
 * rather than a read of `Prisma.dmmf`, which production code may not touch
 * (check-raw-sql-usage); a unit test holds it equal to the dmmf.
 */
export const MODEL_TABLE = {
  account: "accounts",
  session: "sessions",
  verificationToken: "verification_tokens",
  user: "users",
  extensionToken: "extension_tokens",
  extensionBridgeCode: "extension_bridge_codes",
  mobileBridgeCode: "mobile_bridge_codes",
  scimToken: "scim_tokens",
  scimExternalMapping: "scim_external_mappings",
  tag: "tags",
  vaultKey: "vault_keys",
  passwordEntry: "password_entries",
  team: "teams",
  tenant: "tenants",
  tenantMember: "tenant_members",
  scimGroupMapping: "scim_group_mappings",
  teamMember: "team_members",
  teamMemberKey: "team_member_keys",
  teamPasswordEntry: "team_password_entries",
  teamTag: "team_tags",
  teamPasswordFavorite: "team_password_favorites",
  teamInvitation: "team_invitations",
  passwordShare: "password_shares",
  shareAccessLog: "share_access_logs",
  auditLog: "audit_logs",
  auditChainAnchor: "audit_chain_anchors",
  auditOutbox: "audit_outbox",
  auditDeliveryTarget: "audit_delivery_targets",
  auditDelivery: "audit_deliveries",
  webhookDelivery: "webhook_deliveries",
  accessRequest: "access_requests",
  attachment: "attachments",
  emergencyAccessGrant: "emergency_access_grants",
  folder: "folders",
  teamFolder: "team_folders",
  passwordEntryHistory: "password_entry_histories",
  teamPasswordEntryHistory: "team_password_entry_histories",
  emergencyAccessKeyPair: "emergency_access_key_pairs",
  notification: "notifications",
  teamPolicy: "team_policies",
  teamWebhook: "team_webhooks",
  tenantWebhook: "tenant_webhooks",
  adminVaultReset: "admin_vault_resets",
  masterKeyRotation: "master_key_rotations",
  serviceAccount: "service_accounts",
  serviceAccountToken: "service_account_tokens",
  operatorToken: "operator_tokens",
  tenantClaim: "tenant_claims",
  tenantClaimEvent: "tenant_claim_events",
  apiKey: "api_keys",
  webAuthnCredential: "webauthn_credentials",
  directorySyncConfig: "directory_sync_configs",
  directorySyncLog: "directory_sync_logs",
  personalLogAccessGrant: "personal_log_access_grants",
  mcpClient: "mcp_clients",
  mcpAuthorizationCode: "mcp_authorization_codes",
  mcpAccessToken: "mcp_access_tokens",
  mcpRefreshToken: "mcp_refresh_tokens",
  delegationSession: "delegation_sessions",
  systemSetting: "system_settings",
} as const;

export type BypassModel = keyof typeof MODEL_TABLE;

/**
 * What a bypass may reach: its purpose and the models it touches. The
 * database reports (and, once enforced, refuses) a bypassed statement that
 * examines a row of an RLS table outside `tables` — see
 * `public.rls_bypass_admits` in the migrations.
 */
export type BypassGrant = Readonly<{
  purpose: BypassPurpose;
  models: readonly BypassModel[];
  /** `app.bypass_tables`: the tables, comma-joined with no spaces. */
  tables: string;
}>;

export function defineGrant(purpose: BypassPurpose, models: readonly BypassModel[]): BypassGrant {
  if (models.length === 0) throw new Error("a bypass grant names at least one model");
  const tables = [...new Set(models.map((m) => MODEL_TABLE[m]))].sort().join(",");
  return Object.freeze({ purpose, models: Object.freeze([...models]), tables });
}

const TABLE_MODEL: Readonly<Record<string, BypassModel>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(MODEL_TABLE) as [BypassModel, string][]).map(([model, table]) => [table, model]),
  ),
);

/**
 * `defineGrant` from raw table names rather than model names — for a caller
 * that only has the table a reached SQL statement names (retention-gc-worker's
 * per-entry grants, built from the registry's table column). Throws on a table
 * `MODEL_TABLE` does not reverse, the same fail-closed shape as `defineGrant`
 * throwing on an empty model list.
 */
export function grantForTables(purpose: BypassPurpose, tables: readonly string[]): BypassGrant {
  const models = tables.map((t) => {
    const model = TABLE_MODEL[t];
    if (!model) throw new Error(`grantForTables: no model maps to table "${t}"`);
    return model;
  });
  return defineGrant(purpose, models);
}

/**
 * Every named production bypass grant, one per distinct (purpose, model set) —
 * call sites whose sets are equal share an entry (D2). Derived from the static
 * gate's per-call reach, plus raw-SQL tables in reached code, the SECURITY
 * DEFINER audit-function callers, and the self-setting worker/retention paths.
 * scripts/checks/check-bypass-rls.mjs holds the set to the live call sites: it
 * reads each member off this object's AST, fails a withBypassRls call that
 * reaches a model its grant does not list, a member no call or self-setting
 * site names, and a model no call naming the grant reaches (unless one of
 * those calls reaches raw SQL, whose tables it does not read).
 */
export const BYPASS_GRANT = Object.freeze({
  ACCESS_REQUEST_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["accessRequest"]),
  ACCOUNT_TOKEN_MIGRATION: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["account"]),
  ADMIN_VAULT_RESET_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["adminVaultReset"]),
  API_KEY_VALIDATE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["apiKey"]),
  AUDIT_ANCHOR_PUBLISH: defineGrant(BYPASS_PURPOSE.AUDIT_ANCHOR_PUBLISH, ["systemSetting", "auditChainAnchor", "tenant"]),
  AUDIT_CHAIN_VERIFY_ANCHOR_READ: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["auditChainAnchor"]),
  AUDIT_CHAIN_VERIFY_SENTINEL_READ: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["auditChainAnchor", "auditLog"]),
  AUDIT_LOG_CROSS_TENANT_READ: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["auditLog"]),
  AUDIT_LOG_MAINTENANCE_ACCESS: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["auditLog"]),
  AUDIT_OUTBOX_CROSS_TENANT_READ: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["auditOutbox"]),
  AUDIT_OUTBOX_ENQUEUE: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditOutbox", "tenant"]),
  AUDIT_OUTBOX_OPERATOR_ACCESS: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["auditOutbox"]),
  AUDIT_TENANT_RESOLVE: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["team", "user", "tenantMember"]),
  AUDIT_USER_DISPLAY_LOOKUP: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["user"]),
  AUDIT_WRITE_DIRECT_OUTBOX: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditOutbox"]),
  AUTH_ACCOUNT_LOOKUP: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["account", "user"]),
  AUTH_CREATE_USER: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["tenant", "tenantClaim", "tenantMember", "user"]),
  AUTH_DELETE_USER: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["session", "user"]),
  AUTH_LINK_ACCOUNT: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["account", "user", "tenantMember"]),
  AUTH_SESSION_CAPPING: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["session", "tenant"]),
  AUTH_SESSION_LIFECYCLE: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["session", "user"]),
  AUTH_SESSION_PASSKEY_RECOVERY: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["session", "webAuthnCredential"]),
  AUTH_SESSION_PASSKEY_STATUS: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["tenant", "user", "webAuthnCredential", "tenantMember"]),
  AUTH_SIGNIN_TENANT_LOOKUP: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["tenant", "user", "tenantMember", "teamMember", "team", "teamPolicy"]),
  AUTH_TENANT_CLAIM_MEMBERSHIP: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["account", "apiKey", "attachment", "auditLog", "auditOutbox", "delegationSession", "emergencyAccessGrant", "emergencyAccessKeyPair", "extensionBridgeCode", "extensionToken", "folder", "mcpAccessToken", "mcpAuthorizationCode", "mcpRefreshToken", "mobileBridgeCode", "notification", "operatorToken", "passwordEntry", "passwordEntryHistory", "passwordShare", "session", "shareAccessLog", "tag", "teamMemberKey", "teamPasswordFavorite", "tenant", "tenantClaim", "tenantMember", "user", "vaultKey", "webAuthnCredential"]),
  AUTH_USER_LOOKUP: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["user", "tenantMember"]),
  CROSS_TENANT_USER_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["user", "tenantMember"]),
  DELEGATION_MCP_TOKEN_CHECK: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["mcpAccessToken", "mcpClient"]),
  DELEGATION_SESSION_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["delegationSession", "mcpAccessToken", "mcpClient"]),
  EMERGENCY_ACCESS_GRANT_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["emergencyAccessGrant", "user", "emergencyAccessKeyPair"]),
  EMERGENCY_ACCESS_KEY_EXCHANGE: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["emergencyAccessGrant", "emergencyAccessKeyPair"]),
  EMERGENCY_ACCESS_VAULT_READ: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["auditOutbox", "emergencyAccessGrant", "user", "emergencyAccessKeyPair", "tenantMember"]),
  EXTENSION_BRIDGE_CODE_LIFECYCLE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["extensionBridgeCode"]),
  EXTENSION_TOKEN_LIFECYCLE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["extensionToken"]),
  LOCKOUT_ADMIN_NOTIFY: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["tenantMember", "user"]),
  MAINTENANCE_OPERATOR_CHECK: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenantMember"]),
  // scripts/manual-tests/mcp-replay-audit-verification.ts: seeds/cleans up an MCP client + tokens as a superuser fixture.
  MANUAL_MCP_REPLAY_VERIFICATION: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["mcpAccessToken", "mcpClient", "mcpRefreshToken", "tenant", "user", "auditLog", "auditOutbox"]),
  MASTER_KEY_ROTATION_SHARE_UPDATE: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["passwordShare"]),
  MCP_ACCESS_TOKEN_VALIDATE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["mcpAccessToken", "mcpClient"]),
  MCP_AUTH_CODE_LIFECYCLE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["mcpAuthorizationCode"]),
  MCP_CLIENT_CONSENT: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["mcpClient", "mcpAccessToken"]),
  MCP_CLIENT_LOOKUP: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["mcpClient"]),
  MCP_CODE_EXCHANGE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["mcpAccessToken", "mcpAuthorizationCode", "tenant", "webAuthnCredential", "mcpClient"]),
  MCP_REFRESH_EXCHANGE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["mcpAccessToken", "mcpRefreshToken", "tenant", "tenantMember", "webAuthnCredential", "mcpClient"]),
  MCP_REFRESH_TOKEN_LIFECYCLE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["mcpRefreshToken"]),
  MCP_TOKEN_REVOCATION: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["mcpAccessToken", "mcpRefreshToken", "mcpClient"]),
  MCP_TOKEN_REVOKE_WITH_AUDIT: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["auditLog", "delegationSession", "mcpAccessToken", "mcpRefreshToken"]),
  MOBILE_BRIDGE_CODE_LIFECYCLE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["mobileBridgeCode"]),
  NOTIFICATION_CROSS_TENANT_CREATE: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["notification", "user", "tenantMember"]),
  OPERATOR_TOKEN_VALIDATE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["operatorToken"]),
  OUTBOX_AUDIT_DELIVERY: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditDelivery", "auditDeliveryTarget", "auditOutbox", "auditLog"]),
  OUTBOX_DEPTH_READ: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditOutbox"]),
  OUTBOX_DRAIN: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditOutbox", "auditLog", "auditChainAnchor", "auditDelivery", "auditDeliveryTarget", "webhookDelivery", "tenant"]),
  OUTBOX_ERROR_RECORD: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditOutbox", "auditLog"]),
  OUTBOX_REAPER: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditOutbox", "auditLog", "auditDelivery", "webhookDelivery"]),
  OUTBOX_RETENTION_PURGE: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditOutbox", "auditLog", "auditDelivery", "webhookDelivery"]),
  OUTBOX_WEBHOOK_DELIVERY: defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["webhookDelivery", "teamWebhook", "tenantWebhook", "auditOutbox", "auditLog"]),
  PASSKEY_EMAIL_OPTIONS: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["webAuthnCredential"]),
  PASSKEY_ENFORCEMENT_STATE: defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["tenant", "webAuthnCredential"]),
  PASSWORD_HISTORY_PURGE: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["passwordEntryHistory"]),
  QUOTA_USAGE_SCAN: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["attachment", "passwordEntry", "passwordShare", "teamWebhook", "tenantWebhook"]),
  RETENTION_ACCESS_REQUEST_EXPIRY: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["accessRequest"]),
  RETENTION_HEARTBEAT: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["auditOutbox", "tenant"]),
  SCIM_TOKEN_VALIDATE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["scimToken"]),
  SCIM_USER_MAPPING_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["scimExternalMapping", "tenantMember", "user"]),
  SERVICE_ACCOUNT_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["serviceAccount"]),
  SERVICE_ACCOUNT_TOKEN_VALIDATE: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["serviceAccountToken", "serviceAccount"]),
  SHARE_LINK_PUBLIC_ACCESS: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["passwordShare", "shareAccessLog"]),
  SHARE_LINK_VERIFY_ACCESS: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["passwordShare"]),
  SYSTEM_MAINTENANCE_TENANT_LOOKUP: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenant"]),
  TEAM_ADMIN_MEMBERSHIP_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["teamMember", "tenantMember", "team", "tenant"]),
  TEAM_INVITATION_ACCEPT: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["teamInvitation", "team"]),
  TEAM_MEMBER_DISPLAY_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["tenantMember", "user", "tenant"]),
  TEAM_PENDING_KEY_DISTRIBUTION: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["teamMember", "user", "team"]),
  TEAM_TENANT_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["team", "tenant"]),
  TEAM_WEBHOOK_DISPATCH: defineGrant(BYPASS_PURPOSE.WEBHOOK_DISPATCH, ["teamWebhook"]),
  TENANT_CLAIM_BINDING_READ: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["account", "tenant", "tenantClaim", "tenantClaimEvent", "tenantMember"]),
  TENANT_CLAIM_BINDING_WRITE: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["account", "tenant", "tenantClaim", "tenantClaimEvent", "tenantMember"]),
  TENANT_CLAIM_HISTORY: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenant", "tenantClaim", "tenantClaimEvent"]),
  TENANT_CLAIM_LIST: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenant", "tenantClaim"]),
  TENANT_CLAIM_REGISTER: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenant", "tenantClaim", "tenantMember"]),
  TENANT_DOMAIN_BACKFILL_APPLY: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["account", "apiKey", "attachment", "auditOutbox", "delegationSession", "emergencyAccessGrant", "extensionBridgeCode", "extensionToken", "folder", "mcpAccessToken", "mcpAuthorizationCode", "mcpRefreshToken", "mobileBridgeCode", "notification", "operatorToken", "passwordEntry", "passwordShare", "session", "tag", "teamMemberKey", "teamPasswordFavorite", "user", "vaultKey", "webAuthnCredential", "tenantMember"]),
  TENANT_DOMAIN_DIVERGENCE_READ: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenantMember", "user"]),
  TENANT_DOMAIN_UNMAPPED_REPORT: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["auditLog", "auditOutbox", "tenantClaim"]),
  TENANT_LEGACY_ACCOUNT_READ: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["account", "tenant", "tenantMember"]),
  TENANT_MEMBERSHIP_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["tenantMember", "user"]),
  TENANT_POLICY_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["tenant"]),
  TENANT_REALIGN_AFTER_ACTIVATION: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["account", "apiKey", "attachment", "auditOutbox", "delegationSession", "emergencyAccessGrant", "extensionBridgeCode", "extensionToken", "folder", "mcpAccessToken", "mcpAuthorizationCode", "mcpRefreshToken", "mobileBridgeCode", "notification", "operatorToken", "passwordEntry", "passwordShare", "session", "tag", "teamMemberKey", "teamPasswordFavorite", "tenantMember", "user", "vaultKey", "webAuthnCredential"]),
  TENANT_REALIGN_MEMBERSHIP: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["account", "apiKey", "attachment", "auditOutbox", "delegationSession", "emergencyAccessGrant", "extensionBridgeCode", "extensionToken", "folder", "mcpAccessToken", "mcpAuthorizationCode", "mcpRefreshToken", "mobileBridgeCode", "notification", "operatorToken", "passwordEntry", "passwordShare", "session", "tag", "teamMemberKey", "teamPasswordFavorite", "tenant", "tenantClaim", "tenantMember", "user", "vaultKey", "webAuthnCredential"]),
  TENANT_SESSION_CACHE_INVALIDATION: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["session"]),
  TENANT_TEAM_POLICY_LOOKUP: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["teamPolicy", "tenant", "team"]),
  TENANT_WEBHOOK_DISPATCH: defineGrant(BYPASS_PURPOSE.WEBHOOK_DISPATCH, ["tenantWebhook"]),
  TOKEN_TENANT_LOOKUP: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["tenant"]),
  TOKEN_TENANT_MEMBERSHIP_CHECK: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["tenantMember"]),
  USER_SESSION_CACHE_INVALIDATION: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["session"]),
  USER_SESSION_INVALIDATION: defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["apiKey", "delegationSession", "extensionToken", "mcpAccessToken", "mcpRefreshToken", "operatorToken", "session"]),
  VAULT_ENTRY_CROSS_TENANT_READ: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["passwordEntry"]),
  VAULT_RESET_COUNT: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["attachment", "passwordEntry"]),
  VAULT_RESET_EXECUTE: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["attachment", "auditOutbox", "emergencyAccessGrant", "folder", "passwordEntry", "passwordShare", "tag", "team", "teamMember", "teamMemberKey", "user", "vaultKey"]),
  VAULT_RESET_SCOPE_CHECK: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["attachment", "emergencyAccessGrant", "folder", "passwordEntry", "passwordShare", "tag", "vaultKey"]),
  WEBAUTHN_AUTHORIZE_CREDENTIAL: defineGrant(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, ["webAuthnCredential", "user"]),
  WEBHOOK_SECRET_MIGRATION: defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["teamWebhook", "tenantWebhook"]),
} satisfies Record<string, BypassGrant>);

/**
 * Turn the RLS bypass on for the current transaction, for `grant`'s tables.
 * The single writer of the bypass GUCs (check-bypass-rls's writer rule); every
 * setting is transaction-local. `tenantId` defaults to NIL so both arms of the
 * policies cast cleanly; the anchor publisher passes SYSTEM_TENANT_ID.
 */
export async function setBypassGucs(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  grant: BypassGrant,
  { tenantId = NIL_UUID }: { tenantId?: string } = {},
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true),
                              set_config('app.bypass_purpose', ${grant.purpose}, true),
                              set_config('app.tenant_id', ${tenantId}, true),
                              set_config('app.bypass_tables', ${grant.tables}, true)`;
}

/**
 * Open a tenant-scoped transaction's context (withTenantRls): the tenant id,
 * with the bypass pinned off and the grant cleared, in one statement — so a
 * bypass GUC left on the connection by anything else cannot turn the tenant
 * transaction into a bypass.
 */
export async function setTenantGucs(tx: Pick<Prisma.TransactionClient, "$executeRaw">, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true),
                              set_config('app.bypass_rls', 'off', true),
                              set_config('app.bypass_tables', '', true)`;
}

/** `SET LOCAL lock_timeout`, the one other session setting production code takes. */
export async function setLockTimeout(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  ms: number,
): Promise<void> {
  if (!Number.isInteger(ms) || ms <= 0) throw new Error("lock timeout must be a positive integer of milliseconds");
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${ms}ms`}, true)`;
}

/**
 * The transaction's current lock_timeout, as `current_setting` spells it
 * ("0", "3s", "1500ms"), for restoring it after a bounded wait.
 */
export async function readLockTimeout(tx: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<string> {
  const [row] = await tx.$queryRaw<{ lock_timeout: string }[]>`
    SELECT current_setting('lock_timeout') AS lock_timeout
  `;
  if (!row) throw new Error("lock_timeout read returned no row");
  return row.lock_timeout;
}

/** `SET LOCAL lock_timeout` back to a value readLockTimeout returned. */
export async function restoreLockTimeout(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  value: string,
): Promise<void> {
  if (!/^\d+(us|ms|s|min|h|d)?$/.test(value)) throw new Error("not a lock_timeout value");
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${value}, true)`;
}

export type BypassState = {
  bypassRls: string | null;
  purpose: string | null;
  tenantId: string | null;
  tables: string | null;
};

/**
 * The single reader of the bypass GUCs on the current transaction. Null when
 * the read returned no row: current_setting() always yields one, so that is a
 * failed read, and each caller's check must deny on it rather than read it as
 * "bypass off".
 */
export async function readBypassState(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
): Promise<BypassState | null> {
  const rows = await tx.$queryRaw<
    { bypass_rls: string | null; purpose: string | null; tenant_id: string | null; tables: string | null }[]
  >`SELECT current_setting('app.bypass_rls', true) AS bypass_rls,
           current_setting('app.bypass_purpose', true) AS purpose,
           current_setting('app.tenant_id', true) AS tenant_id,
           current_setting('app.bypass_tables', true) AS tables`;
  const row = rows[0];
  if (!row) return null;
  return {
    bypassRls: row.bypass_rls ?? null,
    purpose: row.purpose ?? null,
    tenantId: row.tenant_id ?? null,
    tables: row.tables ?? null,
  };
}
