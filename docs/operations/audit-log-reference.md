# Audit Log Reference

This document lists all audit log action types (150+), their scopes, metadata fields, and UI/export behavior.

---

## Common Fields

Every audit log record contains these base fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique log entry ID |
| `action` | AuditAction | Action type (see tables below) |
| `scope` | AuditScope | `PERSONAL`, `TEAM`, or `TENANT` |
| `userId` | string | User who performed the action |
| `tenantId` | string? | Tenant context (TENANT/TEAM scope) |
| `teamId` | string? | Team context (TEAM scope) |
| `targetType` | string? | Type of the affected resource |
| `targetId` | string? | ID of the affected resource |
| `metadata` | JSON? | Action-specific structured data |
| `ip` | string? | Client IP address |
| `userAgent` | string? | Client User-Agent header |
| `createdAt` | DateTime | Timestamp |

### ip/userAgent Availability

- **HTTP request routes**: Always included via `extractRequestMeta(req)`
- **Auth.js events** (AUTH_LOGIN via OAuth/SAML/Magic Link, AUTH_LOGOUT): Not available (Auth.js limitation)
- **System events** (WEBHOOK_DELIVERY_FAILED, TENANT_WEBHOOK_DELIVERY_FAILED, DIRECTORY_SYNC_STALE_RESET, TEAM_E2E_MIGRATION, PERSONAL_LOG_ACCESS_EXPIRE): Not available (no HTTP context)
- **Passkey AUTH_LOGIN**: Included (custom route with request access)

### Special userId Values

Audit records use sentinel UUIDs paired with an `actorType` discriminator for non-human actions. The two sentinel values are defined in `src/lib/constants/app.ts`:

| Sentinel UUID | `actorType` | Used by | Reason |
|---------------|------------|---------|--------|
| `00000000-0000-4000-8000-000000000000` (`ANONYMOUS_ACTOR_ID`) | `ANONYMOUS` | SHARE_ACCESS_VERIFY_SUCCESS, SHARE_ACCESS_VERIFY_FAILED | No session required for share verification |
| `00000000-0000-4000-8000-000000000001` (`SYSTEM_ACTOR_ID`) | `SYSTEM` | WEBHOOK_DELIVERY_FAILED, TENANT_WEBHOOK_DELIVERY_FAILED, DIRECTORY_SYNC_STALE_RESET, TEAM_E2E_MIGRATION | Background processing with no user context |

For `ACCESS_DENIED` events, `userId` may fall back to the `ANONYMOUS_ACTOR_ID` sentinel with `actorType=ANONYMOUS` when no session exists at the time of denial.

### ActorType

The `actorType` field classifies the actor on every audit record:

| Value | Actor | Notes |
|-------|-------|-------|
| `HUMAN` | Authenticated user (session or operator token) | Default for all user-initiated actions |
| `SERVICE_ACCOUNT` | Service account via `sa_` Bearer token | `userId` is the SA's representing user UUID |
| `MCP_AGENT` | MCP client via `mcp_` token | `userId` is the agent's representing user UUID when applicable |
| `SYSTEM` | Background processing (no user context) | Paired with `SYSTEM_ACTOR_ID` sentinel UUID |
| `ANONYMOUS` | No session (share access, access denied) | Paired with `ANONYMOUS_ACTOR_ID` sentinel UUID |

SIEM rules that previously matched `userId="system"` or `userId="anonymous"` string literals should migrate to matching on the sentinel UUID + `actorType` tuple.

---

## Metadata UI Display Policy

Metadata fields fall into two categories:

| Category | Policy | Examples |
|----------|--------|----------|
| **User-meaningful** | Display in UI and export | `provider`, `entryCount`, `attempts`, `lockMinutes`, `deletedEntries`, `revokedCount`, `format`, `filename` |
| **Internal / diagnostic** | Export only (CSV/JSONL) | `keyVersion`, `resetId`, `wrapVersion`, `credentialId`, `ownerId`, `granteeId`, `declinedBy`, `rejectedBy`, `webhookId` |

### Rationale

- **UI**: Shows only fields that help users understand what happened at a glance
- **Export**: Contains ALL metadata via `JSON.stringify(log.metadata)` for forensic analysis and compliance
- **No data loss**: Internal fields are always persisted in DB and included in exports

### Recommended UI Additions

These user-meaningful fields should be rendered in `getTargetLabel()` with i18n support:

| Field | Action(s) | Display format |
|-------|-----------|----------------|
| `provider` | AUTH_LOGIN | "Provider: google" / "Provider: passkey" |
| `entryCount` | EMERGENCY_VAULT_ACCESS | "Entries accessed: 42" |
| `attempts` | VAULT_UNLOCK_FAILED | "Failed attempts: 3" |
| `lockMinutes` | VAULT_LOCKOUT_TRIGGERED | "Locked for: 15 min" |
| `deletedEntries` | VAULT_RESET_EXECUTED, ADMIN_VAULT_RESET_EXECUTE | "Deleted entries: 10" |
| `revokedCount` | SESSION_REVOKE_ALL | "Revoked sessions: 5" |

---

## Action Types by Group

### Authentication (`group:auth`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `AUTH_LOGIN` | PERSONAL | — | `{ provider }` | provider |
| `AUTH_LOGOUT` | PERSONAL | — | — | — |
| `VAULT_UNLOCK_FAILED` | PERSONAL | — | `{ attempts }` or `{ reason: "lock_timeout" }` | attempts |
| `VAULT_LOCKOUT_TRIGGERED` | PERSONAL | — | `{ attempts, lockMinutes }` | attempts, lockMinutes |
| `SESSION_REVOKE` | PERSONAL | Session | — | — |
| `SESSION_REVOKE_ALL` | PERSONAL | — | `{ revokedCount }` | revokedCount |
| `SESSION_EVICTED` | PERSONAL | Session | `{ reason, maxConcurrentSessions, newSessionIp, newSessionUa }` | reason |

**Notes:**
- AUTH_LOGIN: Auth.js providers (Google/SAML/Magic Link) have no ip/userAgent. Passkey includes ip/userAgent.
- AUTH_LOGIN: `provider` field added by `fix-audit-log-consistency` branch (Auth.js via `account?.provider`, passkey hardcoded `"passkey"`).
- SESSION_EVICTED: Logged when a new session exceeds the concurrent session limit and evicts the oldest session.

### Vault & Recovery (`group:auth`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `VAULT_SETUP` | PERSONAL | — | `{ kdfType, kdfIterations, kdfMemory?, kdfParallelism? }` | — (export-only) |
| `RECOVERY_KEY_CREATED` | PERSONAL | — | `{ keyVersion }` | — (export-only) |
| `RECOVERY_KEY_REGENERATED` | PERSONAL | — | `{ keyVersion }` | — (export-only) |
| `RECOVERY_PASSPHRASE_RESET` | PERSONAL | — | `{ keyVersion, recoveryKeyRegenerated, lockoutReset }` | — (export-only) |
| `VAULT_RESET_EXECUTED` | PERSONAL | — | `{ deletedEntries, deletedAttachments }` | deletedEntries |

**Notes:**
- `keyVersion` added to RECOVERY_KEY_CREATED/REGENERATED by `audit-metadata-standardize` branch.
- VAULT_SETUP: `kdfMemory` and `kdfParallelism` are only present when `kdfType=1` (Argon2id).

### Entry Operations (`group:entry`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `ENTRY_CREATE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | `{ source, filename, parentAction }` (import) or — | — (import details shown by ENTRY_IMPORT) |
| `ENTRY_UPDATE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | — | — |
| `ENTRY_TRASH` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | `{ permanent: false }` | — |
| `ENTRY_DELETE` | TEAM | TeamPasswordEntry | `{ permanent }` | permanent flag |
| `ENTRY_PERMANENT_DELETE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | `{ permanent: true }` | permanent flag |
| `ENTRY_RESTORE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | — | — |

**Notes:**
- ENTRY_TRASH: Used by both personal and team bulk-trash operations (single-item soft delete).
- ENTRY_PERMANENT_DELETE: Used by team empty-trash in addition to personal permanent delete.

### Bulk Actions (`group:bulk`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `ENTRY_BULK_TRASH` | PERSONAL/TEAM | PasswordEntry | `{ bulk, requestedCount, movedCount, entryIds }` | bulkTrashMeta template |
| `ENTRY_EMPTY_TRASH` | PERSONAL/TEAM | PasswordEntry | `{ operation, deletedCount, entryIds }` | emptyTrashMeta template |
| `ENTRY_BULK_ARCHIVE` | PERSONAL/TEAM | PasswordEntry | `{ bulk, operation, requestedCount, processedCount, archivedCount, entryIds }` | bulkArchiveMeta template |
| `ENTRY_BULK_UNARCHIVE` | PERSONAL/TEAM | PasswordEntry | `{ bulk, operation, requestedCount, processedCount, unarchivedCount, entryIds }` | bulkUnarchiveMeta template |
| `ENTRY_BULK_RESTORE` | PERSONAL/TEAM | PasswordEntry | `{ bulk, operation, requestedCount, restoredCount, entryIds }` | bulkRestoreMeta template |

**Notes:**
- `entryIds` arrays are export-only (not displayed in UI).
- Count fields are rendered via i18n templates (e.g., `bulkTrashMeta`).

### Import / Export (`group:transfer`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `ENTRY_IMPORT` | PERSONAL | PasswordEntry | `{ format, encrypted, filename, requestedCount, successCount, failedCount }` | importMeta template |
| `ENTRY_EXPORT` | PERSONAL/TEAM | — | `{ format, encrypted, entryCount, filename, includeTeams }` | exportMeta template |

### Attachments (`group:attachment`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `ATTACHMENT_UPLOAD` | PERSONAL/TEAM | Attachment | `{ filename, sizeBytes, entryId }` | filename |
| `ATTACHMENT_DELETE` | PERSONAL/TEAM | Attachment | `{ filename }` | filename |

### Folders (`group:folder`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `FOLDER_CREATE` | PERSONAL/TEAM | Folder / TeamFolder | — | — |
| `FOLDER_UPDATE` | PERSONAL/TEAM | Folder / TeamFolder | — | — |
| `FOLDER_DELETE` | PERSONAL/TEAM | Folder / TeamFolder | — | — |

### History (`group:history`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `ENTRY_HISTORY_RESTORE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | `{ restoredFromChangedAt }` | — (export-only) |
| `HISTORY_PURGE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | `{ purgedCount }` | purgedCount |
| `ENTRY_HISTORY_REENCRYPT` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | Personal: `{ historyId, oldKeyVersion, newKeyVersion }` / Team: `{ historyId, oldTeamKeyVersion, newTeamKeyVersion, oldItemKeyVersion, newItemKeyVersion }` | — (export-only) |

### Share Links (`group:share`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `SHARE_CREATE` | PERSONAL/TEAM | PasswordShare | `{ expiresIn, maxViews }` | — (export-only) |
| `SHARE_REVOKE` | PERSONAL/TEAM | PasswordShare | — | — |
| `SHARE_ACCESS_VERIFY_SUCCESS` | PERSONAL | PasswordShare | `{ ip }` | — (export-only) |
| `SHARE_ACCESS_VERIFY_FAILED` | PERSONAL | PasswordShare | `{ ip }` | — (export-only) |

**Notes:**
- SHARE_ACCESS_VERIFY_SUCCESS/FAILED: userId is `"anonymous"` (no session required).

### Send (`group:send`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `SEND_CREATE` | PERSONAL | PasswordShare | `{ expiresIn, maxViews }` | — (export-only) |
| `SEND_REVOKE` | PERSONAL | PasswordShare | — | — |

### Team Management (`group:team`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `TEAM_MEMBER_ADD` | TEAM | TeamMember | `{ userId, role, reactivated }` | role |
| `TEAM_MEMBER_INVITE` | TEAM | TeamInvitation | `{ inviteeEmail }` | inviteeEmail |
| `TEAM_MEMBER_REMOVE` | TEAM | TeamMember | `{ removedUserId, removedRole }` | removedRole |
| `TEAM_ROLE_UPDATE` | TEAM | TeamMember | `{ newRole, previousRole, transfer }` | roleChange template |

**Notes:**
- TEAM_MEMBER_ADD: Logged when a member is directly added (not via invitation). `reactivated` is true when a previously removed member is re-added.

### Emergency Access (`group:emergency`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `EMERGENCY_GRANT_CREATE` | PERSONAL | EmergencyAccessGrant | `{ granteeEmail, waitDays }` | eaGrantCreatedFor template |
| `EMERGENCY_GRANT_ACCEPT` | PERSONAL | EmergencyAccessGrant | `{ ownerId }` | eaGrantAcceptedBy template |
| `EMERGENCY_GRANT_REJECT` | PERSONAL | EmergencyAccessGrant | `{ ownerId, declinedBy }` or `{ ownerId, rejectedBy }` | eaGrantRejectedBy template |
| `EMERGENCY_GRANT_CONFIRM` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, wrapVersion, keyVersion }` | eaGrantConfirmedFor template |
| `EMERGENCY_ACCESS_REQUEST` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, waitDays }` | eaAccessRequestedBy template |
| `EMERGENCY_ACCESS_ACTIVATE` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, earlyApproval }` | eaAccessActivatedFor template |
| `EMERGENCY_ACCESS_REVOKE` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, permanent }` | eaAccessRevokedFor template |
| `EMERGENCY_VAULT_ACCESS` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, entryCount }` | viewedByOwner template, entryCount |

**Notes:**
- `ownerId` added to GRANT_CONFIRM, ACCESS_REQUEST, ACCESS_REVOKE, decline/reject by `audit-metadata-standardize` branch.
- `granteeId` added to ACCESS_REQUEST, VAULT_ACCESS by `audit-metadata-standardize` branch.
- `declinedBy`/`rejectedBy` added by `audit-metadata-standardize` branch (captures who performed the action when granteeId is NULL in PENDING state).
- `ownerId`, `granteeId`, `wrapVersion`, `keyVersion`, `declinedBy`, `rejectedBy` are export-only (internal IDs).
- `earlyApproval` added by `fix-audit-log-consistency` branch.
- UI renders emergency access using `relatedUsers` map to resolve user IDs to names.

### API Keys (`group:apiKeys`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `API_KEY_CREATE` | PERSONAL | ApiKey | `{ name, scopes }` | name |
| `API_KEY_REVOKE` | PERSONAL | ApiKey | — | — |

### Travel Mode (`group:travelMode`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `TRAVEL_MODE_ENABLE` | PERSONAL | — | — | — |
| `TRAVEL_MODE_DISABLE` | PERSONAL | — | — | — |
| `TRAVEL_MODE_DISABLE_FAILED` | PERSONAL | — | — | — |

### Passkeys (`group:webauthn`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `WEBAUTHN_CREDENTIAL_REGISTER` | PERSONAL | WebAuthnCredential | `{ credentialId, deviceType, backedUp, prfSupported }` | deviceType |
| `WEBAUTHN_CREDENTIAL_DELETE` | PERSONAL | WebAuthnCredential | — | — |

### Watchtower

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `WATCHTOWER_ALERT_SENT` | PERSONAL/TEAM | — | `{ newBreachCount, teamId? }` | newBreachCount |

### Admin (`group:admin`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `MASTER_KEY_ROTATION` | TEAM | — | `{ targetVersion, revokedShares }` | — (export-only) |
| `TEAM_E2E_MIGRATION` | TEAM | — | — | — |
| `TEAM_KEY_ROTATION` | TEAM | TeamPasswordEntry | `{ fromVersion, toVersion, entriesRotated, membersUpdated }` | — (export-only) |
| `TEAM_MEMBER_KEY_DISTRIBUTE` | TEAM | TeamMember | — | — |
| `POLICY_UPDATE` | TEAM | Team | `{ ...policyFields }` | — (export-only) |
| `AUDIT_LOG_DOWNLOAD` | PERSONAL/TEAM | — | `{ format, filterCriteria, rowCount }` | format, rowCount |
| `ADMIN_VAULT_RESET_INITIATE` | TENANT | User | `{ resetId }` | — (export-only) |
| `ADMIN_VAULT_RESET_EXECUTE` | TENANT | User | `{ deletedEntries, deletedAttachments, ... }` | deletedEntries |
| `ADMIN_VAULT_RESET_REVOKE` | TENANT | User | `{ revokedById, resetId }` | — (export-only) |
| `TENANT_ROLE_UPDATE` | TENANT | TenantMember | `{ newRole, previousRole, transfer }` | roleChange template |

**Notes:**
- `resetId` added to ADMIN_VAULT_RESET_INITIATE by `audit-metadata-standardize` branch.
- System events (TEAM_E2E_MIGRATION) have no ip/userAgent.
- TEAM_KEY_ROTATION: `targetType` is TeamPasswordEntry, `targetId` is teamId.
- TENANT_ROLE_UPDATE: `transfer` is true for ownership transfers.

### SCIM Provisioning (`group:scim`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `SCIM_TOKEN_CREATE` | TENANT | ScimToken | `{ description, expiresInDays }` | description |
| `SCIM_TOKEN_REVOKE` | TENANT | ScimToken | — | — |
| `SCIM_USER_CREATE` | TENANT | ScimExternalMapping | `{ email, externalId }` | email |
| `SCIM_USER_UPDATE` | TENANT | ScimExternalMapping | PUT: `{ email, externalId, active }` / PATCH: `{ active?, name? }` | email, active |
| `SCIM_USER_DEACTIVATE` | TENANT | ScimExternalMapping | — | — |
| `SCIM_USER_REACTIVATE` | TENANT | ScimExternalMapping | — | — |
| `SCIM_USER_DELETE` | TENANT | ScimExternalMapping | — | — |
| `SCIM_GROUP_UPDATE` | TENANT | Team | `{ displayName, members }` | displayName |

### Team Webhooks (`group:webhook`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `WEBHOOK_CREATE` | TEAM | — | `{ webhookId, url }` | — (export-only) |
| `WEBHOOK_DELETE` | TEAM | — | `{ webhookId, url }` | — (export-only) |
| `WEBHOOK_DELIVERY_FAILED` | TEAM | — | `{ webhookId, url, failCount }` | failCount |

**Notes:**
- WEBHOOK_DELIVERY_FAILED is a system event: no ip/userAgent, userId is `"system"`.

### Tenant Webhooks (`group:tenantWebhook`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `TENANT_WEBHOOK_CREATE` | TENANT | — | `{ webhookId, url }` | — (export-only) |
| `TENANT_WEBHOOK_DELETE` | TENANT | — | `{ webhookId, url }` | — (export-only) |
| `TENANT_WEBHOOK_DELIVERY_FAILED` | TENANT | — | `{ webhookId, url, failCount }` | failCount |

**Notes:**
- TENANT_WEBHOOK_DELIVERY_FAILED is a system event: no ip/userAgent, userId is `"system"`.
- Tenant webhooks subscribe to a subset of tenant audit actions (19 total). Excludes the TENANT_WEBHOOK group itself (prevents self-referential loops) and privacy-sensitive actions (PERSONAL_LOG_ACCESS_VIEW, PERSONAL_LOG_ACCESS_EXPIRE).

### Directory Sync (`group:directorySync`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `DIRECTORY_SYNC_CONFIG_CREATE` | TENANT | DirectorySyncConfig | `{ provider, syncIntervalMinutes }` | provider |
| `DIRECTORY_SYNC_CONFIG_UPDATE` | TENANT | DirectorySyncConfig | `{ provider, syncIntervalMinutes }` | provider |
| `DIRECTORY_SYNC_CONFIG_DELETE` | TENANT | DirectorySyncConfig | — | — |
| `DIRECTORY_SYNC_RUN` | TENANT | DirectorySyncConfig | `{ dryRun, force, usersCreated, usersUpdated, usersDeactivated }` | usersCreated, usersUpdated, usersDeactivated |
| `DIRECTORY_SYNC_STALE_RESET` | TENANT | DirectorySyncConfig | `{ staleSince }` | — (export-only) |

**Notes:**
- DIRECTORY_SYNC_STALE_RESET is a system event: no ip/userAgent.

### Break-Glass Access (`group:breakglass`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `PERSONAL_LOG_ACCESS_REQUEST` | TENANT | User | `{ targetUserId, targetUserEmail, reason, incidentRef, grantId }` | targetUserEmail, reason |
| `PERSONAL_LOG_ACCESS_VIEW` | TENANT | User | `{ grantId, targetUserId }` | — (export-only) |
| `PERSONAL_LOG_ACCESS_REVOKE` | TENANT | User | `{ grantId, requesterId, targetUserId, revokedById }` | — (export-only) |
| `PERSONAL_LOG_ACCESS_EXPIRE` | TENANT | User | `{ grantId, targetUserId }` | — (export-only) |

**Notes:**
- Break-Glass allows tenant admins to access a user's personal audit logs with justification.
- PERSONAL_LOG_ACCESS_VIEW: Rate-limited to one audit log entry per hour per grant (in-memory deduplication).
- PERSONAL_LOG_ACCESS_EXPIRE: System event (no ip/userAgent), lazily recorded on first access attempt after grant expiration.
- `requesterId`, `revokedById`, `grantId`, `targetUserId` are export-only (internal IDs).

### Access Control

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `ACCESS_DENIED` | TENANT | — | `{ clientIp, reason }` | — (export-only) |

**Notes:**
- Logged when IP/network access restrictions block a request.
- userId may be `"unknown"` if no session exists at the time of denial.

### MCP Clients (`group:mcpClient`)

| Action | Scope | targetType | metadata | UI display |
|--------|-------|------------|----------|------------|
| `MCP_CLIENT_CREATE` | TENANT | McpClient | `{ name }` | name |
| `MCP_CLIENT_UPDATE` | TENANT | McpClient | `{ name }` | name |
| `MCP_CLIENT_DELETE` | TENANT | McpClient | `{ name }` | name |
| `MCP_CLIENT_DCR_REGISTER` | TENANT | McpClient | `{ clientName, ip }` | clientName |
| `MCP_CLIENT_DCR_CLAIM` | TENANT | McpClient | `{ clientId, tenantId }` | clientId |
| `MCP_CLIENT_DCR_CLEANUP` | TENANT | — | `{ deleted }` | deleted count |
| `MCP_CONSENT_GRANT` | TENANT | McpClient | `{ clientId, scopes }` | scopes |
| `MCP_CONSENT_DENY` | TENANT | McpClient | `{ clientId }` | — |
| `MCP_REFRESH_TOKEN_ROTATE` | TENANT | McpAccessToken | `{ clientId }` | — |
| `MCP_REFRESH_TOKEN_REPLAY` | TENANT | McpAccessToken | `{ clientId, familyId }` | — (security event) |

**Notes:**
- `MCP_CLIENT_DCR_REGISTER` is a system event (no user session at registration time).
- `MCP_REFRESH_TOKEN_REPLAY` is a security event indicating potential token theft.

---

## Action Group Definitions

### Personal Scope (15 groups)

| Group | Actions |
|-------|---------|
| `group:auth` | AUTH_LOGIN, AUTH_LOGOUT, VAULT_UNLOCK_FAILED, VAULT_LOCKOUT_TRIGGERED, RECOVERY_KEY_CREATED, RECOVERY_KEY_REGENERATED, RECOVERY_PASSPHRASE_RESET, VAULT_SETUP, VAULT_RESET_EXECUTED, SESSION_REVOKE, SESSION_REVOKE_ALL, SESSION_EVICTED, WATCHTOWER_ALERT_SENT, ADMIN_VAULT_RESET_INITIATE, ADMIN_VAULT_RESET_EXECUTE, ADMIN_VAULT_RESET_REVOKE |
| `group:entry` | ENTRY_CREATE, ENTRY_UPDATE, ENTRY_TRASH, ENTRY_PERMANENT_DELETE, ENTRY_RESTORE |
| `group:bulk` | ENTRY_BULK_TRASH, ENTRY_EMPTY_TRASH, ENTRY_BULK_ARCHIVE, ENTRY_BULK_UNARCHIVE, ENTRY_BULK_RESTORE |
| `group:transfer` | ENTRY_IMPORT, ENTRY_EXPORT |
| `group:attachment` | ATTACHMENT_UPLOAD, ATTACHMENT_DELETE |
| `group:team` | TEAM_MEMBER_INVITE, TEAM_MEMBER_REMOVE, TEAM_ROLE_UPDATE |
| `group:folder` | FOLDER_CREATE, FOLDER_UPDATE, FOLDER_DELETE |
| `group:history` | ENTRY_HISTORY_RESTORE, HISTORY_PURGE, ENTRY_HISTORY_REENCRYPT |
| `group:share` | SHARE_CREATE, SHARE_REVOKE, SHARE_ACCESS_VERIFY_SUCCESS, SHARE_ACCESS_VERIFY_FAILED |
| `group:send` | SEND_CREATE, SEND_REVOKE |
| `group:emergency` | EMERGENCY_GRANT_CREATE, EMERGENCY_GRANT_ACCEPT, EMERGENCY_GRANT_REJECT, EMERGENCY_GRANT_CONFIRM, EMERGENCY_ACCESS_REQUEST, EMERGENCY_ACCESS_ACTIVATE, EMERGENCY_ACCESS_REVOKE, EMERGENCY_VAULT_ACCESS |
| `group:apiKeys` | API_KEY_CREATE, API_KEY_REVOKE |
| `group:travelMode` | TRAVEL_MODE_ENABLE, TRAVEL_MODE_DISABLE, TRAVEL_MODE_DISABLE_FAILED |
| `group:webauthn` | WEBAUTHN_CREDENTIAL_REGISTER, WEBAUTHN_CREDENTIAL_DELETE |
| `group:delegation` | DELEGATION_CREATE, DELEGATION_REVOKE, DELEGATION_EXPIRE, DELEGATION_READ, DELEGATION_CHECK |

### Team Scope (10 groups)

| Group | Actions |
|-------|---------|
| `group:entry` | ENTRY_CREATE, ENTRY_UPDATE, ENTRY_TRASH, ENTRY_PERMANENT_DELETE, ENTRY_RESTORE |
| `group:bulk` | ENTRY_BULK_TRASH, ENTRY_EMPTY_TRASH, ENTRY_BULK_ARCHIVE, ENTRY_BULK_UNARCHIVE, ENTRY_BULK_RESTORE |
| `group:transfer` | ENTRY_EXPORT |
| `group:attachment` | ATTACHMENT_UPLOAD, ATTACHMENT_DELETE |
| `group:folder` | FOLDER_CREATE, FOLDER_UPDATE, FOLDER_DELETE |
| `group:history` | ENTRY_HISTORY_RESTORE, HISTORY_PURGE, ENTRY_HISTORY_REENCRYPT |
| `group:team` | TEAM_MEMBER_ADD, TEAM_MEMBER_INVITE, TEAM_MEMBER_REMOVE, TEAM_ROLE_UPDATE |
| `group:share` | SHARE_CREATE, SHARE_REVOKE, SHARE_ACCESS_VERIFY_SUCCESS, SHARE_ACCESS_VERIFY_FAILED |
| `group:admin` | MASTER_KEY_ROTATION, TEAM_E2E_MIGRATION, TEAM_KEY_ROTATION, TEAM_MEMBER_KEY_DISTRIBUTE, POLICY_UPDATE, AUDIT_LOG_DOWNLOAD, WATCHTOWER_ALERT_SENT, ADMIN_VAULT_RESET_INITIATE, ADMIN_VAULT_RESET_EXECUTE |
| `group:scim` | SCIM_TOKEN_CREATE, SCIM_TOKEN_REVOKE, SCIM_USER_CREATE, SCIM_USER_UPDATE, SCIM_USER_DEACTIVATE, SCIM_USER_REACTIVATE, SCIM_USER_DELETE, SCIM_GROUP_UPDATE |
| `group:webhook` | WEBHOOK_CREATE, WEBHOOK_DELETE, WEBHOOK_DELIVERY_FAILED |

### Tenant Scope (8 groups)

| Group | Actions |
|-------|---------|
| `group:admin` | ADMIN_VAULT_RESET_INITIATE, ADMIN_VAULT_RESET_EXECUTE, ADMIN_VAULT_RESET_REVOKE, TENANT_ROLE_UPDATE, HISTORY_PURGE |
| `group:scim` | SCIM_TOKEN_CREATE, SCIM_TOKEN_REVOKE, SCIM_USER_CREATE, SCIM_USER_UPDATE, SCIM_USER_DEACTIVATE, SCIM_USER_REACTIVATE, SCIM_USER_DELETE, SCIM_GROUP_UPDATE |
| `group:directorySync` | DIRECTORY_SYNC_CONFIG_CREATE, DIRECTORY_SYNC_CONFIG_UPDATE, DIRECTORY_SYNC_CONFIG_DELETE, DIRECTORY_SYNC_RUN, DIRECTORY_SYNC_STALE_RESET |
| `group:breakglass` | PERSONAL_LOG_ACCESS_REQUEST, PERSONAL_LOG_ACCESS_VIEW, PERSONAL_LOG_ACCESS_REVOKE, PERSONAL_LOG_ACCESS_EXPIRE |
| `group:tenantWebhook` | TENANT_WEBHOOK_CREATE, TENANT_WEBHOOK_DELETE, TENANT_WEBHOOK_DELIVERY_FAILED |
| `group:serviceAccount` | SERVICE_ACCOUNT_CREATE, SERVICE_ACCOUNT_UPDATE, SERVICE_ACCOUNT_DELETE, SERVICE_ACCOUNT_TOKEN_CREATE, SERVICE_ACCOUNT_TOKEN_REVOKE, ACCESS_REQUEST_CREATE, ACCESS_REQUEST_APPROVE, ACCESS_REQUEST_DENY |
| `group:mcpClient` | MCP_CLIENT_CREATE, MCP_CLIENT_UPDATE, MCP_CLIENT_DELETE, MCP_CLIENT_DCR_REGISTER, MCP_CLIENT_DCR_CLAIM, MCP_CLIENT_DCR_CLEANUP, MCP_CONSENT_GRANT, MCP_CONSENT_DENY, MCP_REFRESH_TOKEN_ROTATE, MCP_REFRESH_TOKEN_REPLAY |
| `group:delegation` | DELEGATION_CREATE, DELEGATION_REVOKE, DELEGATION_EXPIRE, DELEGATION_READ, DELEGATION_CHECK |

---

## AUDIT_TARGET_TYPE Constants (18)

| Constant | Value |
|----------|-------|
| `PASSWORD_ENTRY` | PasswordEntry |
| `TEAM_PASSWORD_ENTRY` | TeamPasswordEntry |
| `ATTACHMENT` | Attachment |
| `FOLDER` | Folder |
| `TEAM_FOLDER` | TeamFolder |
| `EMERGENCY_ACCESS_GRANT` | EmergencyAccessGrant |
| `PASSWORD_SHARE` | PasswordShare |
| `SESSION` | Session |
| `TEAM` | Team |
| `TEAM_MEMBER` | TeamMember |
| `TEAM_INVITATION` | TeamInvitation |
| `API_KEY` | ApiKey |
| `WEBAUTHN_CREDENTIAL` | WebAuthnCredential |
| `SCIM_TOKEN` | ScimToken |
| `SCIM_EXTERNAL_MAPPING` | ScimExternalMapping |
| `DIRECTORY_SYNC_CONFIG` | DirectorySyncConfig |
| `TENANT_MEMBER` | TenantMember |

**Note:** Break-Glass actions use the string `"User"` directly (not a constant).

---

## UI Display

### Personal Audit Log (`/dashboard/audit-logs`)

- **Layout**: Card-based vertical list with action icon, label, target, date, and IP
- **Filtering**: Date range (from/to) + action group filter with search
- **Pagination**: Cursor-based, 50 per page
- **Entry names**: Client-side decrypted from `encryptedOverview` blobs
- **Emergency access**: Resolves user IDs to names via `relatedUsers` map
- **i18n**: All action labels and metadata templates localized (en/ja)

### Team Audit Log (`/dashboard/teams/[teamId]/audit-logs`)

- Same card-based layout with user avatar display
- "Operated by" shows team member info
- Export can be disabled by team policy (`allowExport`)
- Entry names decrypted client-side using team key

### Tenant Audit Log (`/dashboard/tenant` — audit-logs tab)

- Embedded as `TenantAuditLogCard` within the tenant settings page (no standalone route)
- Accessible to tenant admins only
- Shows TENANT-scoped actions (admin resets, SCIM, directory sync, break-glass, tenant webhooks)

### Metadata Display in UI

| Pattern | Display format | Example |
|---------|---------------|---------|
| Bulk operations | "Selected: X / Moved: Y / Not moved: Z" | `bulkTrashMeta` |
| Empty trash | "Permanently deleted from trash: N" | `emptyTrashMeta` |
| Import | "File: X / Format: Y / Success: N / Failed: M" | `importMeta` |
| Export | "File: X / Count: N / Format: Y / Encrypted: yes/no" | `exportMeta` |
| Role change | "MEMBER -> ADMIN" | `roleChange` |
| Emergency access | Context-specific text with user names | `eaGrantCreatedFor`, etc. |
| Permanent delete | "Permanently deleted" label | `permanentDelete` |

---

## Export Formats

### CSV Download (`GET /api/audit-logs/download?format=csv`)

Headers: `id, action, targetType, targetId, ip, userAgent, createdAt, userId, userName, userEmail, metadata`

- Streaming response (no memory buffer)
- CSV injection prevention (escapes `=`, `+`, `-`, `@`, `\t`, `\r`)
- Batch processing: 500 records per chunk
- Max date range: 90 days
- Rate limit: 2 downloads/minute/user
- `metadata` column: `JSON.stringify(log.metadata ?? {})` — ALL fields included, no filtering

### JSONL Download (`GET /api/audit-logs/download?format=jsonl`)

One JSON object per line (NDJSON format). Same fields as CSV. Metadata is native JSON (not stringified).

### Team Download (`GET /api/teams/[teamId]/audit-logs/download`)

Same formats (CSV/JSONL). Requires `TEAM_UPDATE` permission. Respects team `allowExport` policy.

---

## Branch Change Summary

Changes across two feature branches that standardize audit log output:

### `fix-audit-log-consistency` (13 files)

| Change | Files |
|--------|-------|
| String literals -> `AUDIT_TARGET_TYPE.USER` constant | admin-reset, tenant reset routes |
| `extractRequestMeta(req)` spread pattern | recovery-key, vault reset routes |
| `metadata: { provider }` added to AUTH_LOGIN | `auth.ts` (Auth.js), passkey verify route |
| Duplicate `ip` in metadata removed | rotate-master-key route |
| `ownerId` added to emergency approve | approve route |
| `granteeId`, `earlyApproval` added to emergency activate/vault | vault route |

### `audit-metadata-standardize` (8 files)

| Change | Files |
|--------|-------|
| `keyVersion` added to RECOVERY_KEY_CREATED/REGENERATED | recovery-key generate route |
| `resetId` added to ADMIN_VAULT_RESET_INITIATE | tenant reset-vault route |
| `ownerId` added to GRANT_CONFIRM, ACCESS_REQUEST, ACCESS_REVOKE | confirm, request, revoke routes |
| `granteeId` added to ACCESS_REQUEST, VAULT_ACCESS | request, vault/entries routes |
| `declinedBy`/`rejectedBy` added to decline/reject | decline, reject routes |

---

## Source Files

| Component | Path |
|-----------|------|
| Constants | `src/lib/constants/audit.ts`, `src/lib/constants/audit-target.ts` |
| Logging function (`logAuditAsync`) | `src/lib/audit/audit.ts` — `logAudit`/`logAuditBatch` are deprecated; use `logAuditAsync`. Context helpers `personalAuditBase`, `teamAuditBase`, `tenantAuditBase` (#389) are enforced by the `*AuditBase` convention. |
| Auth adapter (SESSION_EVICTED) | `src/lib/auth/auth-adapter.ts` |
| Access restriction (ACCESS_DENIED) | `src/lib/access-restriction.ts` |
| Webhook dispatcher | `src/lib/webhook-dispatcher.ts` |
| Personal API | `src/app/api/audit-logs/route.ts` |
| Team API | `src/app/api/teams/[teamId]/audit-logs/route.ts` |
| Tenant API | `src/app/api/tenant/audit-logs/route.ts` |
| Personal download | `src/app/api/audit-logs/download/route.ts` |
| Team download | `src/app/api/teams/[teamId]/audit-logs/download/route.ts` |
| Tenant download | `src/app/api/tenant/audit-logs/download/route.ts` |
| Break-Glass routes | `src/app/api/tenant/breakglass/route.ts`, `src/app/api/tenant/breakglass/[id]/route.ts`, `src/app/api/tenant/breakglass/[id]/logs/route.ts` |
| Tenant webhooks | `src/app/api/tenant/webhooks/route.ts`, `src/app/api/tenant/webhooks/[webhookId]/route.ts` |
| Personal UI | `src/app/[locale]/dashboard/audit-logs/page.tsx` |
| Team UI | `src/app/[locale]/dashboard/teams/[teamId]/audit-logs/page.tsx` |
| Tenant UI (tab) | `src/components/settings/tenant-audit-log-card.tsx` (embedded in `src/app/[locale]/dashboard/tenant/page.tsx`) |
| i18n (en) | `messages/en/AuditLog.json` |
| i18n (ja) | `messages/ja/AuditLog.json` |
