# Plan: expand-security-policies

## Objective

Expand the configurable security policy items for both tenant-level and team-level policies. Currently, settings are limited and several fields lack enforcement. This plan adds new policy dimensions and strengthens existing enforcement.

## Requirements

### Functional Requirements

1. **Tenant-level: MFA enforcement policy** — Require passkey registration for all tenant members
2. **Tenant-level: Vault lockout policy** — Make lockout thresholds and durations configurable (currently hardcoded: 5/10/15 failures → 15min/1hr/24hr)
3. **Tenant-level: Password expiry policy** — Set maximum age for password entries; notify users of upcoming expiry via Watchtower
4. **Tenant-level: Audit log retention policy** — Configure minimum retention period; prevent deletion before retention window
5. **Team-level: Enforce password complexity** — Change client-side password policy from advisory to blocking (prevent form submission)
6. **Team-level: Password reuse prevention** — Compare against history entries client-side before encryption
7. **Team-level: IP restriction inheritance** — Allow teams to inherit or override tenant CIDR allowlist
8. **Team-level: maxSessionDurationMinutes enforcement** — Implement the currently unenforced field
9. **Tenant-level: Admin UI for requireMinPinLength** — Add missing settings page
10. **Tenant-level: Password policy** — Tenant-wide password complexity rules (applied to personal vault entries, not just teams)

### Non-Functional Requirements

- All new policy fields must have admin UI, i18n (en/ja), and audit logging
- Server-side enforcement where architecturally possible; client-side blocking where E2E encryption prevents server validation
- Backward-compatible: all new fields default to "disabled" / current behavior
- No performance regression on critical paths (session creation, vault unlock, password save)

### Architectural Constraints

**E2E encryption boundary**: The server never sees plaintext passwords. Password content rules (length, complexity, reuse) CANNOT be enforced server-side. These must be enforced client-side by blocking form submission before encryption. This is a deliberate architectural trade-off: the advisory-only pattern in the current codebase must be upgraded to client-side blocking, but server-side enforcement remains impossible.

## Technical Approach

### Phase A: Strengthen Existing Enforcement (Low risk, high value)

1. **Team password policy: advisory → blocking** — Modify `useTeamLoginFormState` and `useTeamBaseFormModel` to disable the submit button when policy violations exist. Add `policyViolations` state to form model; disable submit when non-empty.

2. **Team `maxSessionDurationMinutes` enforcement** — Add server-side check in `auth-adapter.ts` `updateSession()`: query the user's team memberships and enforce the shortest `maxSessionDurationMinutes` across all teams. Delete sessions exceeding the limit.

3. **`requireMinPinLength` admin UI** — Add new page at `/admin/tenant/security/passkey-policy` with a number input for PIN length (4–63).

### Phase B: New Tenant Policies (Schema + API + UI)

4. **MFA enforcement policy** — New fields on `Tenant`:
   - `requirePasskey: Boolean @default(false)` — Require at least one registered passkey
   - `passkeyGracePeriodDays: Int?` — Grace period before enforcement (null = immediate)
   
   Enforcement: In `src/proxy.ts`, after session check, verify the user has at least one WebAuthn credential. During grace period, show a warning banner. After grace period, redirect to passkey registration page.

5. **Configurable vault lockout** — New fields on `Tenant`:
   - `lockoutThreshold1: Int @default(5)` — First lockout threshold
   - `lockoutDuration1Minutes: Int @default(15)` — First lockout duration
   - `lockoutThreshold2: Int @default(10)`
   - `lockoutDuration2Minutes: Int @default(60)`
   - `lockoutThreshold3: Int @default(15)`
   - `lockoutDuration3Minutes: Int @default(1440)`
   
   Refactor `account-lockout.ts` to read thresholds from tenant policy instead of hardcoded constants.

6. **Password expiry policy** — New fields on `Tenant`:
   - `passwordMaxAgeDays: Int?` — Max age for password entries (null = disabled)
   - `passwordExpiryWarningDays: Int @default(14)` — Warning period before expiry
   
   Enforcement: Watchtower scan checks `passwordEntry.updatedAt` against policy. Client shows expiry warnings in dashboard. No forced password change (E2E encryption prevents server-side enforcement).

7. **Audit log retention policy** — New fields on `Tenant`:
   - `auditLogRetentionDays: Int?` — Minimum retention period (null = forever)
   
   Enforcement: `purge-history` script respects retention window. Admin UI shows retention setting.

8. **Tenant-wide password policy** — New fields on `Tenant`:
   - `tenantMinPasswordLength: Int @default(0)`
   - `tenantRequireUppercase: Boolean @default(false)`
   - `tenantRequireLowercase: Boolean @default(false)`
   - `tenantRequireNumbers: Boolean @default(false)`
   - `tenantRequireSymbols: Boolean @default(false)`
   
   Enforcement: Client-side blocking in personal password form. Team policy can only be stricter than tenant policy (floor enforcement).

### Phase C: New Team Policies

9. **Password reuse prevention** — New field on `TeamPolicy`:
   - `passwordHistoryCount: Int @default(0)` — Number of previous passwords to check (0 = disabled)
   
   Client-side enforcement: Before encryption, decrypt the last N history entries and compare plaintext. Block submission if reuse detected. This requires the user's encryption key (already available in vault context).

10. **Team IP restriction** — New fields on `TeamPolicy`:
    - `inheritTenantCidrs: Boolean @default(true)` — Inherit tenant CIDR restrictions
    - `teamAllowedCidrs: String[] @default([])` — Additional team-specific CIDRs
    
    Server-side enforcement: In team password API routes, check client IP against combined CIDR list.

## Implementation Steps

### Step 1: Database Schema Changes

Add new fields to `prisma/schema.prisma`:

**On `Tenant` model:**
```
// MFA enforcement
requirePasskey              Boolean  @default(false) @map("require_passkey")
requirePasskeyEnabledAt     DateTime? @map("require_passkey_enabled_at")
passkeyGracePeriodDays      Int?     @map("passkey_grace_period_days")

// Configurable vault lockout
lockoutThreshold1           Int      @default(5)    @map("lockout_threshold_1")
lockoutDuration1Minutes     Int      @default(15)   @map("lockout_duration_1_minutes")
lockoutThreshold2           Int      @default(10)   @map("lockout_threshold_2")
lockoutDuration2Minutes     Int      @default(60)   @map("lockout_duration_2_minutes")
lockoutThreshold3           Int      @default(15)   @map("lockout_threshold_3")
lockoutDuration3Minutes     Int      @default(1440) @map("lockout_duration_3_minutes")

// Password expiry
passwordMaxAgeDays          Int?     @map("password_max_age_days")
passwordExpiryWarningDays   Int      @default(14)   @map("password_expiry_warning_days")

// Audit log retention
auditLogRetentionDays       Int?     @map("audit_log_retention_days")

// Tenant-wide password policy
tenantMinPasswordLength     Int      @default(0)    @map("tenant_min_password_length")
tenantRequireUppercase      Boolean  @default(false) @map("tenant_require_uppercase")
tenantRequireLowercase      Boolean  @default(false) @map("tenant_require_lowercase")
tenantRequireNumbers        Boolean  @default(false) @map("tenant_require_numbers")
tenantRequireSymbols        Boolean  @default(false) @map("tenant_require_symbols")
```

**On `TeamPolicy` model:**
```
// Password reuse prevention
passwordHistoryCount        Int      @default(0)    @map("password_history_count")

// Team IP restriction
inheritTenantCidrs          Boolean  @default(true) @map("inherit_tenant_cidrs")
teamAllowedCidrs            String[] @default([])   @map("team_allowed_cidrs")
```

Create migration: `prisma/migrations/YYYYMMDDHHMMSS_expand_security_policies/migration.sql`

### Step 2: Validation Schemas

**File: `src/lib/validations/common.ts` and `common.server.ts`** (extend existing pattern, not duplicate)
- Add constants to existing files following the established naming convention (`POLICY_*` prefix):
  - `LOCKOUT_THRESHOLD_MIN=1`, `LOCKOUT_THRESHOLD_MAX=50`
  - `LOCKOUT_DURATION_MIN=1`, `LOCKOUT_DURATION_MAX=10080` (7 days)
  - `PASSWORD_MAX_AGE_MIN=1`, `PASSWORD_MAX_AGE_MAX=730` (2 years)
  - `PASSWORD_EXPIRY_WARNING_MIN=1`, `PASSWORD_EXPIRY_WARNING_MAX=90`
  - `AUDIT_LOG_RETENTION_MIN=30`, `AUDIT_LOG_RETENTION_MAX=3650` (10 years)
  - `PASSKEY_GRACE_PERIOD_MIN=1`, `PASSKEY_GRACE_PERIOD_MAX=90`
  - `PASSWORD_HISTORY_COUNT_MAX=24`
- These extend the existing constants (`POLICY_MIN_PW_LENGTH_MIN/MAX`, `MAX_CIDRS`, etc.) — no new file or pattern needed

**File: `src/lib/validations/team.ts`**
- Add to `upsertTeamPolicySchema`: `passwordHistoryCount`, `inheritTenantCidrs`, `teamAllowedCidrs`

**File: `src/app/api/tenant/policy/route.ts`** (inline in existing handler, not a new file)
- Extract existing inline Zod validation into named schemas within the same file
- Add new field schemas following the same pattern

### Step 3: Tenant Policy API Extension

**File: `src/app/api/tenant/policy/route.ts`**
- Extend GET to return all new fields
- Extend PATCH to accept all new fields with validation
- **Server-side cross-field validation** (Zod `.refine()` or guard clause in PATCH handler):
  - `lockoutThreshold1 < lockoutThreshold2 < lockoutThreshold3` (strict ascending, return 400 if violated)
  - `lockoutDuration1Minutes < lockoutDuration2Minutes < lockoutDuration3Minutes` (strict ascending — equal durations offer no escalation, return 400 if violated)
  - `passwordExpiryWarningDays < passwordMaxAgeDays` when both are set (return 400 if violated)
  - Individual field range checks: `threshold >= LOCKOUT_THRESHOLD_MIN && threshold <= LOCKOUT_THRESHOLD_MAX`
  - `auditLogRetentionDays >= AUDIT_LOG_RETENTION_MIN` (30) when set (return 400 if below minimum)
  - These **must** be enforced server-side (not just UI) to prevent brute-force protection bypass
- **`requirePasskeyEnabledAt` set-once logic**: In the PATCH handler, when `requirePasskey` transitions from `false` to `true`, set `requirePasskeyEnabledAt = new Date()`. When `requirePasskey` is already `true`, do NOT overwrite `requirePasskeyEnabledAt`. When `requirePasskey` is set to `false`, clear `requirePasskeyEnabledAt` to `null`. This prevents grace period clock reset on unrelated tenant updates.

### Step 4: Audit Actions

**File: `prisma/schema.prisma` (AuditAction enum)**
- Add: `PASSKEY_ENFORCEMENT_BLOCKED` — User redirected due to missing passkey
- Add: `LOCKOUT_POLICY_UPDATE` — Vault lockout thresholds changed (subset of POLICY_UPDATE, or use existing POLICY_UPDATE)

**File: `src/lib/constants/audit.ts`**
- Add `PASSKEY_ENFORCEMENT_BLOCKED` to `AUDIT_ACTION` object (key and value)
- Add `PASSKEY_ENFORCEMENT_BLOCKED` to `AUDIT_ACTION_VALUES` array
- Add to `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.ADMIN]` array
- Add to `TENANT_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.ADMIN]` array (this drives `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` auto-derivation)
- Update `audit.test.ts` expected group keys if a new group is added

**Audit log emission sites** (each enforcement point must call `createAuditLog`):
- `src/proxy.ts`: Emit `PASSKEY_ENFORCEMENT_BLOCKED` when redirecting user due to missing passkey
- `src/lib/account-lockout.ts`: Use existing `VAULT_LOCKOUT_TRIGGERED` (no new action needed — thresholds are now configurable but the action is the same)
- `src/lib/auth-adapter.ts`: Emit `SESSION_REVOKE` (existing action) when deleting session due to team `maxSessionDurationMinutes`
- `src/lib/team-policy.ts`: Emit `ACCESS_DENIED` (existing action) when team IP restriction blocks access

### Step 5: Strengthen Team Password Policy Enforcement (advisory → blocking)

**File: `src/hooks/use-team-base-form-model.ts`**
- Add `policyViolations` state derived from current form values + team policy
- Set `submitDisabled = true` when `policyViolations.length > 0`

**File: `src/hooks/use-team-login-form-state.ts`**
- Add real-time policy validation on password field change
- Call `getPolicyViolations()` (from password-generator.tsx, extract to shared util)

**File: `src/components/passwords/password-generator.tsx`**
- Extract `getPolicyViolations()` to `src/lib/password-policy-validation.ts` (shared between generator and form)
- **Remove** the internal `getPolicyViolations` function from `password-generator.tsx` and replace with import from new shared util

**File: `src/lib/password-policy-validation.ts`** (new shared util)
- Define a common `PasswordPolicy` interface that covers both `TeamPolicyClient` (team) and tenant-level policy fields
- `getPolicyViolations(password: string, policy: PasswordPolicy): PolicyViolation[]`
- `checkPasswordReuse(password: string, decryptedHistory: string[]): boolean`
- This shared type will be used in both Step 5 (team forms) and Step 11 (personal forms)

**Files: i18n**
- Add violation message keys to `TeamPolicy.json` (en/ja)

### Step 6: Team maxSessionDurationMinutes Enforcement

**File: `src/lib/auth-adapter.ts`**
- In `updateSession()`, add `createdAt` and `userId` to the existing `select` clause (neither is currently selected; `userId` is needed for `getStrictestSessionDuration(userId)` call)
- After idle timeout check, call `getStrictestSessionDuration(userId)`
- If session `createdAt` + minimum duration < now, delete session and emit `SESSION_REVOKE` audit log

**File: `src/lib/team-policy.ts`**
- Add `getStrictestSessionDuration(userId): Promise<number | null>` — queries all team policies for user's teams, returns the shortest non-null `maxSessionDurationMinutes`
- **Must use `withBypassRls(prisma, BYPASS_PURPOSE.AUTH_FLOW)`** because this is a cross-team query by userId (different from existing `getTeamPolicy` which uses `withTeamTenantRls`)
- Cache result with 60s TTL (same pattern as `access-restriction.ts` `policyCache`)

### Step 7: MFA (Passkey) Enforcement

**IMPORTANT: Edge Runtime constraint** — `proxy.ts` runs as Next.js middleware in Edge Runtime, which cannot make direct DB queries (no TCP/Prisma). The passkey enforcement check must work within this limitation.

**Approach**: Include `hasPasskey: boolean` in the session info returned by `/api/auth/session` (already fetched by `getSessionInfo()` in proxy.ts on every request). This avoids a second DB round-trip from middleware.

**File: `src/lib/auth-adapter.ts`** (or session callback in `src/auth.config.ts`)
- When building the session response, include `hasPasskey: boolean` by querying `prisma.webAuthnCredential.count({ where: { userId } })` (model is `WebAuthnCredential`, NOT `Authenticator`) wrapped in `withBypassRls(prisma, ..., BYPASS_PURPOSE.AUTH_FLOW)`
- Include `tenant.requirePasskey`, `tenant.requirePasskeyEnabledAt`, `tenant.passkeyGracePeriodDays` in the session payload

**File: `src/proxy.ts`** (type updates)
- Extend `SessionInfo` interface (L24-28) to include `hasPasskey: boolean`, `requirePasskey: boolean`, `requirePasskeyEnabledAt: string | null`, `passkeyGracePeriodDays: number | null`
- Update `setSessionCache()` and session cache map type accordingly

**File: `src/types/next-auth.d.ts`** (if session augmentation is used)
- Add `hasPasskey` and passkey policy fields to session type augmentation

**File: `src/proxy.ts`**
- After session check, read `hasPasskey`, `requirePasskey`, grace period from session info (already available, no extra DB call)
- If `requirePasskey && !hasPasskey && gracePeriodExpired`: redirect to hard-coded internal path `/dashboard/settings/security`
- If `requirePasskey && !hasPasskey && withinGracePeriod`: allow request (client fetches grace status from `/api/user/passkey-status` — no response header needed to avoid information leakage via CDN/proxy logs)
- **Exclusion list** (skip passkey check for these routes to prevent registration loop):
  - `/dashboard/settings/security*` (page routes for passkey registration)
  - `/api/webauthn/register/*` (registration API — must be callable)
  - `/api/webauthn/authenticate/*` (authentication API)
  - `/api/auth/*` (auth flow routes)
- **Security**: Do NOT use query parameters as enforcement trigger. Use session-derived data only.

**File: `src/app/api/user/passkey-status/route.ts`** (new)
- Return `{ required: boolean, gracePeriodRemaining: number | null, hasPasskey: boolean }`
- Client uses this API response to show enforcement banner in dashboard

**File: `src/components/settings/passkey-credentials-card.tsx`**
- Show enforcement banner based on API response

**Grace period calculation**: `requirePasskeyEnabledAt + passkeyGracePeriodDays` — the `requirePasskeyEnabledAt` timestamp is set once when `requirePasskey` is changed to `true`, and is NOT reset by other tenant field updates (unlike `updatedAt`).

**Cache staleness note**: `hasPasskey` in `SessionInfo` is cached for 30s (`SESSION_CACHE_TTL_MS`). After a user deletes their last passkey, enforcement is delayed up to 30s. This is an accepted limitation: the user can only delete their own passkeys, and the window is short. Do NOT remove the `X-Passkey-Grace-Remaining` header approach — instead, use the `/api/user/passkey-status` API endpoint for client-side display (no custom header needed).

**Files: i18n**
- Add passkey enforcement messages to `TenantAdmin.json`

### Step 8: Configurable Vault Lockout

**File: `src/lib/account-lockout.ts`**
- Replace hardcoded `LOCKOUT_THRESHOLDS` array with tenant policy lookup
- Add `getLockoutThresholds(tenantId)` function that reads from tenant
- Cache thresholds (same pattern as access-restriction.ts, 60s TTL)

### Step 9: Password Expiry (Watchtower Integration)

**Note**: Watchtower scanning runs **client-side** in `src/hooks/use-watchtower.ts` (the `start` route only enforces rate limits and returns `{ ok: true }`). The expiry check must be added to the client-side hook.

**File: `src/hooks/use-watchtower.ts`**
- Add `passwordMaxAgeDays` and `passwordExpiryWarningDays` to the scan context (fetched from tenant policy via `vault/status` extension in Step 11)
- After existing `expiresAt` check (line ~388), add policy-driven age check: compare `entry.updatedAt` + `passwordMaxAgeDays` against now
- Entries within `passwordExpiryWarningDays` of expiry → add to `EXPIRING_PASSWORD` alert category
- Entries past `passwordMaxAgeDays` → add to `EXPIRED_PASSWORD` alert category
- Note: `updatedAt` is server-visible metadata (not encrypted), so this check works without decryption

**File: `src/lib/constants/watchtower.ts`** (or wherever alert types are defined)
- Add alert types: `EXPIRING_PASSWORD`, `EXPIRED_PASSWORD`

### Step 10: Audit Log Retention

**Note**: `purge-history` route deletes `PasswordEntryHistory` (password change history), NOT `AuditLog`. These are separate tables. This step covers both:

**Subtask 10a: PasswordEntryHistory retention** (existing purge-history route)
- **File: `src/app/api/maintenance/purge-history/route.ts`**
  - This route already deletes `PasswordEntryHistory` records
  - No change needed here for audit log retention (different table)

**Subtask 10b: AuditLog retention enforcement** (new capability)
- **File: `src/app/api/maintenance/purge-audit-logs/route.ts`** (new route)
  - New admin-only endpoint to purge old audit logs
  - Accept `retentionDays` parameter in request body
  - Before purging, check `tenant.auditLogRetentionDays`: if `requestedRetentionDays < tenant.auditLogRetentionDays`, return 400 (cannot delete logs newer than tenant minimum)
  - This is a threshold check on the parameter, NOT a per-record scan
  - Rate limited, Bearer token auth (same pattern as purge-history)
- **File: `scripts/purge-audit-logs.sh`** (new script)
  - Shell wrapper for the new endpoint
  - Respects retention window by default

### Step 11: Tenant-Wide Password Policy

**File: `src/hooks/use-personal-password-form.ts`** (or equivalent)
- Fetch tenant password policy via new API endpoint or extend vault/status
- Apply same blocking validation as team policy

**File: `src/app/api/vault/status/route.ts`**
- Extend response to include tenant password policy fields and `passwordMaxAgeDays`/`passwordExpiryWarningDays` (for Watchtower client-side use)
- **Performance note**: `vault/status` is called on every page load. The tenant policy fields should come from the existing tenant object already fetched for `vaultAutoLockMinutes` — no extra DB query needed

### Step 12: Password Reuse Prevention (Client-Side)

**File: `src/hooks/use-team-login-form-state.ts`**
- When `passwordHistoryCount > 0` and editing an existing entry:
  - Fetch history entries via `GET /api/teams/[teamId]/passwords/[id]/history`
  - Decrypt the last N entries using team encryption key
  - On form submit, compare plaintext password against decrypted history
  - Block submission if match found

**File: `src/lib/password-policy-validation.ts`**
- Add `checkPasswordReuse(password, decryptedHistory): boolean`

### Step 13: Team IP Restriction

**All team resource endpoints** (apply `checkTeamAccessRestriction` after auth check):
- `src/app/api/teams/[teamId]/passwords/route.ts` (and nested: [id], [id]/restore, [id]/attachments/*, [id]/history/*, bulk-*, empty-trash)
- `src/app/api/teams/[teamId]/tags/route.ts` (and [id])
- `src/app/api/teams/[teamId]/folders/route.ts` (and [id])
- `src/app/api/teams/[teamId]/members/route.ts` (and [memberId], [memberId]/confirm-key, search)
- `src/app/api/teams/[teamId]/invitations/route.ts` (and [invId])
- `src/app/api/teams/[teamId]/audit-logs/route.ts` (and download)
- `src/app/api/teams/[teamId]/webhooks/route.ts` (and [webhookId])
- `src/app/api/teams/[teamId]/policy/route.ts`
- `src/app/api/teams/[teamId]/member-key/route.ts`
- `src/app/api/teams/[teamId]/rotate-key/route.ts` (and data)
- **Design**: Create a shared `withTeamIpRestriction(teamId, request)` helper in `team-policy.ts` to avoid repeating the check in every route handler

**File: `src/lib/team-policy.ts`**
- Add `checkTeamAccessRestriction(teamId, clientIp)`: reads team policy, combines with tenant CIDRs if `inheritTenantCidrs`, checks client IP

### Step 14: Admin UI Pages

**New tenant page files** (follow existing pattern: page.tsx renders a Card component):
- `src/app/[locale]/admin/tenant/security/passkey-policy/page.tsx` → `<TenantPasskeyPolicyCard />`
- `src/app/[locale]/admin/tenant/security/lockout-policy/page.tsx` → `<TenantLockoutPolicyCard />`
- `src/app/[locale]/admin/tenant/security/password-policy/page.tsx` → `<TenantPasswordPolicyCard />`
- `src/app/[locale]/admin/tenant/security/retention-policy/page.tsx` → `<TenantRetentionPolicyCard />`

**New Card components:**
- `src/components/settings/tenant-passkey-policy-card.tsx`
- `src/components/settings/tenant-lockout-policy-card.tsx`
- `src/components/settings/tenant-password-policy-card.tsx`
- `src/components/settings/tenant-retention-policy-card.tsx`

**Update tenant sidebar:**
- `src/components/admin/admin-sidebar.tsx` — Add 4 nav items under security section

**Update team policy page:**
- `src/components/team/team-policy-settings.tsx` — Add password reuse and IP restriction sections

**Files: i18n**
- `messages/en/TeamPolicy.json` / `messages/ja/TeamPolicy.json`
- `messages/en/TenantAdmin.json` / `messages/ja/TenantAdmin.json`
- `messages/en/AdminConsole.json` / `messages/ja/AdminConsole.json`

## Implementation Checklist

### Files to modify
- [ ] `prisma/schema.prisma` — Tenant model (add 18 fields), TeamPolicy model (add 3 fields), AuditAction enum (add 1 value)
- [ ] `src/lib/validations/common.ts` — Add validation constants (LOCKOUT_*, PASSWORD_MAX_AGE_*, etc.)
- [ ] `src/lib/validations/common.server.ts` — Add server-only validation constants if needed
- [ ] `src/lib/validations/team.ts` — Extend `upsertTeamPolicySchema` with 3 new fields
- [ ] `src/app/api/tenant/policy/route.ts` — Extend GET/PATCH for all new tenant fields + cross-field validation
- [ ] `src/app/api/teams/[teamId]/policy/route.ts` — Extend PUT for new team fields + rate limiter
- [ ] `src/lib/constants/audit.ts` — Add `PASSKEY_ENFORCEMENT_BLOCKED` to AUDIT_ACTION, AUDIT_ACTION_VALUES, AUDIT_ACTION_GROUPS_TENANT[ADMIN], TENANT_WEBHOOK_EVENT_GROUPS[ADMIN]
- [ ] `src/lib/team-policy.ts` — Add `getStrictestSessionDuration`, `checkTeamAccessRestriction`, `withTeamIpRestriction`, update `DEFAULT_POLICY`, update `getTeamPolicy` return block, update `TeamPolicyData`
- [ ] `src/hooks/use-team-policy.ts` — Extend `TeamPolicyClient` type
- [ ] `src/hooks/use-team-base-form-model.ts` — Add policyViolations state, submitDisabled logic
- [ ] `src/hooks/use-team-login-form-state.ts` — Real-time policy validation
- [ ] `src/components/passwords/password-generator.tsx` — Remove internal getPolicyViolations, import from shared util
- [ ] `src/lib/password-policy-validation.ts` — NEW: shared PasswordPolicy type, getPolicyViolations, checkPasswordReuse
- [ ] `src/lib/auth-adapter.ts` — Add createdAt+userId to updateSession select, add session duration check, add hasPasskey to session response
- [ ] `src/lib/account-lockout.ts` — Replace hardcoded LOCKOUT_THRESHOLDS with getLockoutThresholds(tenantId)
- [ ] `src/lib/access-restriction.ts` — Reference for cache pattern (no changes)
- [ ] `src/proxy.ts` — Add passkey enforcement check in handleDashboardAuth, extend SessionInfo
- [ ] `src/hooks/use-watchtower.ts` — Add passwordMaxAgeDays/passwordExpiryWarningDays expiry checks
- [ ] `src/app/api/vault/status/route.ts` — Extend response with tenant password policy fields
- [ ] `src/app/api/maintenance/purge-history/route.ts` — No changes (PasswordEntryHistory, not AuditLog)
- [ ] `src/app/api/maintenance/purge-audit-logs/route.ts` — NEW: audit log purge with retention check
- [ ] `src/app/api/user/passkey-status/route.ts` — NEW: passkey enforcement status API
- [ ] `scripts/purge-audit-logs.sh` — NEW: shell wrapper
- [ ] `src/components/admin/admin-sidebar.tsx` — Add 4 nav items under tenant security
- [ ] `src/components/settings/tenant-passkey-policy-card.tsx` — NEW
- [ ] `src/components/settings/tenant-lockout-policy-card.tsx` — NEW
- [ ] `src/components/settings/tenant-password-policy-card.tsx` — NEW
- [ ] `src/components/settings/tenant-retention-policy-card.tsx` — NEW
- [ ] `src/app/[locale]/admin/tenant/security/passkey-policy/page.tsx` — NEW
- [ ] `src/app/[locale]/admin/tenant/security/lockout-policy/page.tsx` — NEW
- [ ] `src/app/[locale]/admin/tenant/security/password-policy/page.tsx` — NEW
- [ ] `src/app/[locale]/admin/tenant/security/retention-policy/page.tsx` — NEW
- [ ] `src/components/team/team-policy-settings.tsx` — Add password reuse + IP restriction sections
- [ ] `messages/en/TeamPolicy.json` + `messages/ja/TeamPolicy.json` — New keys
- [ ] `messages/en/TenantAdmin.json` + `messages/ja/TenantAdmin.json` — New keys
- [ ] `messages/en/AdminConsole.json` + `messages/ja/AdminConsole.json` — New nav keys
- [ ] `messages/en/AuditLog.json` + `messages/ja/AuditLog.json` — PASSKEY_ENFORCEMENT_BLOCKED key
- [ ] `src/types/next-auth.d.ts` — Add hasPasskey + passkey policy fields

### Shared utilities to reuse (NOT reimplment)
- `createRateLimiter` from `src/lib/rate-limit.ts` — for new routes
- `logAudit` + `extractRequestMeta` from `src/lib/audit.ts` — for audit logging
- `withBypassRls` + `BYPASS_PURPOSE` from `src/lib/tenant-rls.ts` — for cross-tenant queries
- `withTeamTenantRls` from `src/lib/tenant-context.ts` — for team-scoped queries
- `invalidateTenantPolicyCache` from `src/lib/access-restriction.ts` — call after tenant policy update
- `verifyAdminToken` from `src/lib/admin-auth.ts` — for new admin maintenance route
- `fetchApi` + `API_PATH` from `src/lib/fetch-api.ts` — for client-side API calls
- Policy cache pattern from `src/lib/access-restriction.ts` (Map + TTL + invalidation)
- Card component pattern from `src/components/settings/tenant-session-policy-card.tsx`
- `SectionCardHeader` from `src/components/ui/section-card-header.tsx`

### Existing test constants to update
- `tenant-policy.test.ts`: `FULL_POLICY_RESPONSE` + L284-318 hardcoded expectations
- `account-lockout.test.ts`: Mock strategy migration (vi.hoisted for getLockoutThresholds)
- `team-policy.test.ts`: `fullPolicy`, DEFAULT_POLICY, "returns mapped policy" assertions, add `vi.mock("@/lib/tenant-rls")`
- `audit.test.ts`: AUDIT_ACTION_VALUES assertion
- `AuditLog.json` (en/ja): i18n key for new audit action

### Step 15: Build and Type Generation

- Run `npx prisma generate` after schema changes to update `@prisma/client` types
- Run `npx next build` to verify all new pages, components, and API routes compile
- Verify no missing i18n keys at runtime (next-intl will warn on missing keys)

### Step 16: Tests

**Existing test file updates (must-do to prevent CI failures):**

- `tenant-policy.test.ts`:
  - Update `FULL_POLICY_RESPONSE` constant with all 14+ new field defaults
  - Update the hardcoded `toEqual` expectations in "successfully updates all policy fields" test (L284-318) — these don't reference `FULL_POLICY_RESPONSE` and must be updated separately

- `account-lockout.test.ts` — **migration strategy for ~20 existing tests**:
  1. Current tests assert hardcoded thresholds (5/10/15 → 15min/60min/1440min) against module-level `LOCKOUT_THRESHOLDS` constant
  2. After refactoring to `getLockoutThresholds(tenantId)`, mock this function at module level using `vi.hoisted` pattern (consistent with existing project mocks)
  3. **Return type must match existing field names**: `{attempts: number, lockMinutes: number}[]` — keep the same key names as current `LOCKOUT_THRESHOLDS` constant. Default mock returns `[{attempts:15,lockMinutes:1440},{attempts:10,lockMinutes:60},{attempts:5,lockMinutes:15}]` — same values and key names as current hardcoded constants, so existing test assertions (including `notifyAdminsOfLockout` calls checking `lockMinutes: 15` etc.) remain valid
  4. Add new describe block with custom thresholds (e.g., 3/7/12 → 30min/2hr/24hr) to test dynamic behavior
  5. Add test confirming `getLockoutThresholds` is called with correct `tenantId`

- `team-policy.test.ts`:
  - Update `fullPolicy` constant (L29-41) with new 3 fields: `passwordHistoryCount: 5`, `inheritTenantCidrs: true`, `teamAllowedCidrs: ["10.0.0.0/8"]`
  - Update `DEFAULT_POLICY` expected values in "returns default policy" test (L48-63) with: `passwordHistoryCount: 0`, `inheritTenantCidrs: true`, `teamAllowedCidrs: []`
  - **Also update `getTeamPolicy` return block in `team-policy.ts` (L40-51)** — explicit field mapping requires manual addition of new fields
  - Update "returns mapped policy when DB record exists" test (L65-73) to add assertions for `passwordHistoryCount`, `inheritTenantCidrs`, `teamAllowedCidrs` (currently only spot-checks 4 fields)

- `team-policy.test.ts` (for `getStrictestSessionDuration` tests):
  - **Add `vi.mock("@/lib/tenant-rls", ...)` mock** — `getStrictestSessionDuration` uses `withBypassRls` from `tenant-rls.ts`, which is NOT currently mocked in `team-policy.test.ts` (only `withTeamTenantRls` from `tenant-context.ts` is mocked)

- `audit.test.ts`:
  - No group key changes needed (adding to existing ADMIN group, not creating new group)
  - But `AUDIT_ACTION_VALUES` assertion will need updating for the new action

- `AuditLog.json` (en/ja): Add i18n key for `PASSKEY_ENFORCEMENT_BLOCKED` — the `audit-log-keys.test.ts` validates that every `AUDIT_ACTION` value has a corresponding i18n key

**New unit tests:**
- `password-policy-validation.test.ts`: Pure function tests for `getPolicyViolations()` and `checkPasswordReuse()` (NOT React component render tests — Vitest node env cannot render React)
- `account-lockout.test.ts` (extend): Tests with dynamic thresholds from tenant policy
- `team-policy.test.ts` (extend): `getStrictestSessionDuration` with multiple teams, `checkTeamAccessRestriction` with CIDR combinations
- Watchtower password expiry detection tests
- Audit log retention enforcement tests (new purge-audit-logs route)
- Tenant password policy floor enforcement on team policy

**API validation tests:**
- PATCH round-trip for all new tenant policy fields
- Cross-field validation boundary tests: `threshold1 == threshold2` → 400, `warningDays >= maxAgeDays` → 400, valid monotonic values → 200
- Import shared constants from `validations/common.ts` (not hardcoded values) per RT3 pattern

**Coverage:**
- Add `src/lib/password-policy-validation.ts` to `vitest.config.ts` `coverage.include`
- Add `src/lib/team-policy.ts` to `vitest.config.ts` `coverage.include` (currently missing — needed for `getStrictestSessionDuration`, `checkTeamAccessRestriction`)

## Testing Strategy

- **Unit tests**: All new validation schemas, policy enforcement functions, lockout threshold logic
- **Component tests**: Form submission blocking with policy violations, admin UI pages render correctly
- **API tests**: PATCH round-trip for all new tenant/team policy fields, validation rejection for invalid values
- **Build verification**: `npx next build` after all changes
- **Manual verification**: Confirm client-side blocking prevents form submission with policy violations

## Considerations & Constraints

1. **E2E encryption boundary**: Password content (length, complexity, reuse) can ONLY be enforced client-side. This is an inherent architectural limitation. A malicious client (or direct API call) can bypass these checks. This is acceptable because:
   - The threat model assumes authenticated users with legitimate clients
   - API-only users (v1 API, extension, CLI) bypass complexity enforcement due to the E2E encryption boundary — this is an accepted architectural limitation for all authenticated API clients
   - Adding a plaintext hash for server-side validation would break the E2E security model

2. **Password reuse check performance**: Decrypting N history entries client-side may be slow for large history counts. Cap `passwordHistoryCount` at 24 and decrypt lazily.

3. **Team session duration enforcement**: Querying all team memberships on every session refresh adds DB load. Use caching (60s TTL, same pattern as access restriction).

4. **Backward compatibility**: All new fields default to "disabled" state. Existing tenants/teams see no behavior change until an admin explicitly enables policies.

5. **Scope exclusion**: TOTP/HOTP as a login 2FA factor is NOT included — login authentication is delegated to external IdPs via Auth.js. The MFA policy here means "require passkey registration," not "add TOTP to the login flow."

6. **Lockout policy must be monotonic**: `threshold1 < threshold2 < threshold3` (strict ascending) and `duration1 < duration2 < duration3` (strict ascending — equal durations across different thresholds provide no escalation, making intermediate thresholds pointless).

## User Operation Scenarios

### Scenario 1: Tenant Admin Enables MFA Enforcement
1. Admin navigates to `/admin/tenant/security/passkey-policy`
2. Enables "Require passkey" toggle, sets grace period to 30 days
3. Saves — `POLICY_UPDATE` audit log
4. Users without passkeys see warning banner for 30 days
5. After 30 days, users without passkeys are redirected to security settings on every page load
6. User registers a passkey → enforcement check passes → normal access resumes

### Scenario 2: Team Admin Blocks Non-Compliant Passwords
1. Team admin sets `minPasswordLength: 16`, `requireSymbols: true` in team policy
2. Team member opens password form, types "short"
3. Form shows violation: "Password must be at least 16 characters" + "Password must contain symbols"
4. Submit button is disabled (previously was just a warning)
5. User adjusts password to comply → violations clear → submit enabled

### Scenario 3: Password Reuse Detection
1. Team admin sets `passwordHistoryCount: 5`
2. User edits an existing entry, types the same password as 2 versions ago
3. Client decrypts last 5 history entries, detects match
4. Form shows: "This password was used recently. Choose a different password."
5. Submit remains disabled until a unique password is entered

### Scenario 4: Configurable Vault Lockout
1. Tenant admin changes lockout to 3/7/12 failures → 30min/2hr/24hr
2. User fails vault unlock 3 times → locked for 30 minutes (instead of default 5 → 15min)
3. Audit log shows `VAULT_LOCKOUT_TRIGGERED` with the new threshold

### Scenario 5: Password Expiry Warning
1. Tenant admin sets `passwordMaxAgeDays: 90`, `passwordExpiryWarningDays: 14`
2. Watchtower scan detects entries last updated > 76 days ago
3. Dashboard shows "5 passwords expiring within 14 days" alert
4. Entries > 90 days old shown as "expired" in Watchtower results
