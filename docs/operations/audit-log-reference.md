# Audit Log Reference

This document lists all audit log action types, their scopes, metadata fields, and UI/export behavior.

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
- **System events** (WEBHOOK_DELIVERY_FAILED, DIRECTORY_SYNC_STALE_RESET, TEAM_E2E_MIGRATION): Not available (no HTTP context)
- **Passkey AUTH_LOGIN**: Included (custom route with request access)

---

## Action Types by Group

### Authentication (`group:auth`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `AUTH_LOGIN` | PERSONAL | — | `{ provider }` | Auth.js: no ip/userAgent. Passkey: ip/userAgent included |
| `AUTH_LOGOUT` | PERSONAL | — | — | Auth.js event: no ip/userAgent |
| `VAULT_UNLOCK_FAILED` | PERSONAL | — | `{ attempts }` or `{ reason: "lock_timeout" }` | |
| `VAULT_LOCKOUT_TRIGGERED` | PERSONAL | — | `{ attempts, lockMinutes }` | |
| `SESSION_REVOKE` | PERSONAL | Session | — | |
| `SESSION_REVOKE_ALL` | PERSONAL | — | `{ revokedCount }` | |

### Vault & Recovery (`group:auth`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `RECOVERY_KEY_CREATED` | PERSONAL | — | `{ keyVersion }` | |
| `RECOVERY_KEY_REGENERATED` | PERSONAL | — | `{ keyVersion }` | |
| `RECOVERY_PASSPHRASE_RESET` | PERSONAL | — | `{ keyVersion, recoveryKeyRegenerated, lockoutReset }` | |
| `VAULT_RESET_EXECUTED` | PERSONAL | — | `{ deletedEntries, deletedAttachments }` | |

### Entry Operations (`group:entry`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `ENTRY_CREATE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | `{ source, filename, parentAction }` (import) or — | |
| `ENTRY_UPDATE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | — | |
| `ENTRY_TRASH` | PERSONAL | PasswordEntry | `{ permanent: false }` | |
| `ENTRY_DELETE` | TEAM | TeamPasswordEntry | `{ permanent }` | Team uses ENTRY_DELETE with permanent flag |
| `ENTRY_PERMANENT_DELETE` | PERSONAL | PasswordEntry | `{ permanent: true }` | |
| `ENTRY_RESTORE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | — | |

### Bulk Actions (`group:bulk`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `ENTRY_BULK_TRASH` | PERSONAL/TEAM | PasswordEntry | `{ bulk, requestedCount, movedCount, entryIds }` | |
| `ENTRY_EMPTY_TRASH` | PERSONAL/TEAM | PasswordEntry | `{ operation, deletedCount, entryIds }` | |
| `ENTRY_BULK_ARCHIVE` | PERSONAL/TEAM | PasswordEntry | `{ bulk, operation, requestedCount, processedCount, archivedCount, entryIds }` | |
| `ENTRY_BULK_UNARCHIVE` | PERSONAL/TEAM | PasswordEntry | `{ bulk, operation, requestedCount, processedCount, unarchivedCount, entryIds }` | |
| `ENTRY_BULK_RESTORE` | PERSONAL/TEAM | PasswordEntry | `{ bulk, operation, requestedCount, restoredCount, entryIds }` | |

### Import / Export (`group:transfer`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `ENTRY_IMPORT` | PERSONAL | PasswordEntry | `{ format, encrypted, filename, requestedCount, successCount, failedCount }` | |
| `ENTRY_EXPORT` | PERSONAL/TEAM | — | `{ format, encrypted, entryCount, filename, includeTeams }` | |

### Attachments (`group:attachment`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `ATTACHMENT_UPLOAD` | PERSONAL/TEAM | Attachment | `{ filename, sizeBytes, entryId }` | |
| `ATTACHMENT_DELETE` | PERSONAL/TEAM | Attachment | `{ filename }` | |

### Folders (`group:folder`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `FOLDER_CREATE` | PERSONAL/TEAM | Folder / TeamFolder | — | |
| `FOLDER_UPDATE` | PERSONAL/TEAM | Folder / TeamFolder | — | |
| `FOLDER_DELETE` | PERSONAL/TEAM | Folder / TeamFolder | — | |

### History (`group:history`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `ENTRY_HISTORY_RESTORE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | `{ restoredFromChangedAt }` | |
| `HISTORY_PURGE` | PERSONAL/TEAM | PasswordEntry / TeamPasswordEntry | `{ purgedCount }` | |

### Share Links (`group:share`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `SHARE_CREATE` | PERSONAL/TEAM | PasswordShare | `{ expiresIn, maxViews }` | |
| `SHARE_REVOKE` | PERSONAL/TEAM | PasswordShare | — | |

### Send (`group:send`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `SEND_CREATE` | PERSONAL | PasswordShare | `{ expiresIn, maxViews }` | |
| `SEND_REVOKE` | PERSONAL | PasswordShare | — | |

### Team Management (`group:team`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `TEAM_MEMBER_INVITE` | TEAM | TeamInvitation | `{ inviteeEmail }` | |
| `TEAM_MEMBER_REMOVE` | TEAM | TeamMember | `{ removedUserId, removedRole }` | |
| `TEAM_ROLE_UPDATE` | TEAM | TeamMember | `{ newRole, previousRole, transfer }` | |

### Emergency Access (`group:emergency`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `EMERGENCY_GRANT_CREATE` | PERSONAL | EmergencyAccessGrant | `{ granteeEmail, waitDays }` | userId = ownerId |
| `EMERGENCY_GRANT_ACCEPT` | PERSONAL | EmergencyAccessGrant | `{ ownerId }` | userId = granteeId |
| `EMERGENCY_GRANT_REJECT` | PERSONAL | EmergencyAccessGrant | `{ ownerId, declinedBy }` or `{ ownerId, rejectedBy }` | decline = by ID, reject = by token |
| `EMERGENCY_GRANT_CONFIRM` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, wrapVersion, keyVersion }` | userId = ownerId |
| `EMERGENCY_ACCESS_REQUEST` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, waitDays }` | userId = granteeId |
| `EMERGENCY_ACCESS_ACTIVATE` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, earlyApproval }` | |
| `EMERGENCY_ACCESS_REVOKE` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, permanent }` | permanent: true = full revoke, false = reject request |
| `EMERGENCY_VAULT_ACCESS` | PERSONAL | EmergencyAccessGrant | `{ ownerId, granteeId, entryCount }` | userId = granteeId |

### API Keys (`group:apiKeys`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `API_KEY_CREATE` | PERSONAL | ApiKey | `{ name, scopes }` | |
| `API_KEY_REVOKE` | PERSONAL | ApiKey | — | |

### Travel Mode (`group:travelMode`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `TRAVEL_MODE_ENABLE` | PERSONAL | — | — | |
| `TRAVEL_MODE_DISABLE` | PERSONAL | — | — | |
| `TRAVEL_MODE_DISABLE_FAILED` | PERSONAL | — | — | |

### Passkeys (`group:webauthn`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `WEBAUTHN_CREDENTIAL_REGISTER` | PERSONAL | WebAuthnCredential | `{ credentialId, deviceType, backedUp, prfSupported }` | |
| `WEBAUTHN_CREDENTIAL_DELETE` | PERSONAL | WebAuthnCredential | — | |

### Watchtower

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `WATCHTOWER_ALERT_SENT` | PERSONAL | — | `{ alertType, count }` | |

### Admin (`group:admin`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `MASTER_KEY_ROTATION` | TEAM | — | `{ targetVersion, revokedShares }` | |
| `TEAM_E2E_MIGRATION` | TEAM | — | — | System event: no ip/userAgent |
| `TEAM_KEY_ROTATION` | TEAM | — | — | |
| `TEAM_MEMBER_KEY_DISTRIBUTE` | TEAM | TeamMember | — | |
| `POLICY_UPDATE` | TEAM | Team | `{ ...policyFields }` | Full policy object |
| `AUDIT_LOG_DOWNLOAD` | PERSONAL/TEAM | — | `{ format, filterCriteria, rowCount }` | |
| `ADMIN_VAULT_RESET_INITIATE` | TENANT | User | `{ resetId }` | |
| `ADMIN_VAULT_RESET_EXECUTE` | TENANT | User | `{ deletedEntries, deletedAttachments, ... }` | |
| `ADMIN_VAULT_RESET_REVOKE` | TENANT | User | `{ revokedById, resetId }` | |

### SCIM Provisioning (`group:scim`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `SCIM_TOKEN_CREATE` | TENANT | ScimToken | `{ description, expiresInDays }` | |
| `SCIM_TOKEN_REVOKE` | TENANT | ScimToken | — | |
| `SCIM_USER_CREATE` | TENANT | ScimExternalMapping | `{ email, externalId }` | |
| `SCIM_USER_UPDATE` | TENANT | ScimExternalMapping | PUT: `{ email, externalId, active }` / PATCH: `{ active?, name? }` | |
| `SCIM_USER_DEACTIVATE` | TENANT | ScimExternalMapping | — | |
| `SCIM_USER_REACTIVATE` | TENANT | ScimExternalMapping | — | |
| `SCIM_USER_DELETE` | TENANT | ScimExternalMapping | — | |
| `SCIM_GROUP_UPDATE` | TENANT | Team | `{ displayName, members }` | |

### Webhooks (`group:webhook`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `WEBHOOK_CREATE` | TEAM | — | `{ url, events }` | |
| `WEBHOOK_DELETE` | TEAM | — | — | |
| `WEBHOOK_DELIVERY_FAILED` | TEAM | — | `{ httpStatus, error }` | System event: no ip/userAgent |

### Directory Sync (`group:directorySync`)

| Action | Scope | targetType | metadata | Notes |
|--------|-------|------------|----------|-------|
| `DIRECTORY_SYNC_CONFIG_CREATE` | TENANT | DirectorySyncConfig | `{ provider, syncIntervalMinutes }` | |
| `DIRECTORY_SYNC_CONFIG_UPDATE` | TENANT | DirectorySyncConfig | `{ provider, syncIntervalMinutes }` | |
| `DIRECTORY_SYNC_CONFIG_DELETE` | TENANT | DirectorySyncConfig | — | |
| `DIRECTORY_SYNC_RUN` | TENANT | DirectorySyncConfig | `{ dryRun, force, usersCreated, usersUpdated, usersDeactivated }` | |
| `DIRECTORY_SYNC_STALE_RESET` | TENANT | DirectorySyncConfig | `{ staleSince }` | System event: no ip/userAgent |

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

### Metadata Display in UI

| Pattern | Display format | Example |
|---------|---------------|---------|
| Bulk operations | "Selected: X / Moved: Y / Not moved: Z" | `bulkTrashMeta` |
| Empty trash | "Permanently deleted from trash: N" | `emptyTrashMeta` |
| Import | "File: X / Format: Y / Success: N / Failed: M" | `importMeta` |
| Export | "File: X / Count: N / Format: Y / Encrypted: yes/no" | `exportMeta` |
| Role change | "MEMBER → ADMIN" | `roleChange` |
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

### JSONL Download (`GET /api/audit-logs/download?format=jsonl`)

One JSON object per line (NDJSON format). Same fields as CSV.

### Team Download (`GET /api/teams/[teamId]/audit-logs/download`)

Same formats (CSV/JSONL). Requires `TEAM_UPDATE` permission. Respects team `allowExport` policy.

---

## Source Files

| Component | Path |
|-----------|------|
| Constants | `src/lib/constants/audit.ts`, `src/lib/constants/audit-target.ts` |
| Logging function | `src/lib/audit.ts` |
| Personal API | `src/app/api/audit-logs/route.ts` |
| Team API | `src/app/api/teams/[teamId]/audit-logs/route.ts` |
| Personal download | `src/app/api/audit-logs/download/route.ts` |
| Team download | `src/app/api/teams/[teamId]/audit-logs/download/route.ts` |
| Personal UI | `src/app/[locale]/dashboard/audit-logs/page.tsx` |
| Team UI | `src/app/[locale]/dashboard/teams/[teamId]/audit-logs/page.tsx` |
| i18n (en) | `messages/en/AuditLog.json` |
| i18n (ja) | `messages/ja/AuditLog.json` |
