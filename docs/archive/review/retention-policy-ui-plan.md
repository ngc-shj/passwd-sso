# Plan: retention-policy-ui

## Project context
- Service (Next.js + Prisma 7 + PostgreSQL, multi-tenant) — the retention-GC worker series (SC2-SC7 + SC6b) added 5 per-tenant retention columns to Tenant but the tenant policy API/UI does not expose them. `auditLogRetentionDays` (pre-existing) IS exposed and is the pattern to clone.

## Objective
Expose the 5 retention fields added by SC2/SC3/SC7 in the tenant policy API (`/api/tenant/policy` GET + PATCH) and the Retention settings card, so tenant admins can configure them (NULL = never auto-delete, matching the worker's skip-on-null semantics):
- `trashRetentionDays` (SC2 — soft-deleted vault entry purge)
- `historyRetentionDays` (SC3 — password-entry history trim)
- `shareAccessLogRetentionDays` (SC7)
- `directorySyncLogRetentionDays` (SC7)
- `notificationRetentionDays` (SC7)

## Background facts (verified)
- Tenant policy route `src/app/api/tenant/policy/route.ts`: GET selects tenant fields + returns them (auditLogRetentionDays at lines 109/147); PATCH validates each field (auditLogRetentionDays bounds at ~455-465) then writes to the tenant row. Permission: TENANT_PERMISSION.MEMBER_MANAGE; bypass-RLS CROSS_TENANT_LOOKUP.
- UI card `src/components/settings/account/tenant-retention-policy-card.tsx` (181 lines): toggle + numeric input per retention, `bindRangeInput`, fetchApi GET on mount, PATCH on save; i18n namespace TenantAdmin.
- i18n keys in `messages/{en,ja}/TenantAdmin.json` (retentionPolicy* + auditLogRetention*).
- Validation constants `AUDIT_LOG_RETENTION_MIN=30`, `AUDIT_LOG_RETENTION_MAX=10*DAYS_PER_YEAR=3650` in src/lib/validations/common.ts.

## Policy decisions
- **Shared bounds**: reuse a single `RETENTION_DAYS_MIN=1` / `RETENTION_DAYS_MAX=3650` for the 5 new fields (a generic constant; the audit-log floor of 30 is its own stricter constant and unchanged). Min 1 (a tenant can set aggressive cleanup); max 10 years. (Trash/history/logs don't need the audit-log 30-day forensic floor — they're operational cleanup; min 1 is fine.)
- **NULL = never**: each field nullable; the toggle off → null (matches the worker skip-on-null).
- This is API + UI only — NO worker/schema changes (columns + worker already shipped).

## Contracts

### C1 — validation constants — locked
- Add `RETENTION_DAYS_MIN = 1` and `RETENTION_DAYS_MAX = 10 * DAYS_PER_YEAR` to src/lib/validations/common.ts (or reuse AUDIT_LOG_RETENTION_MAX for the max). The 5 new fields validate against these.

### C2 — policy route GET — locked
- Add the 5 fields to the GET `select` and the response object (mirror auditLogRetentionDays: `user?.tenant?.<field> ?? null`).

### C3 — policy route PATCH — locked
- Destructure the 5 fields from the body; validate each (null OR integer within [RETENTION_DAYS_MIN, RETENTION_DAYS_MAX]) mirroring the auditLogRetentionDays validation block; include each in the tenant update data (only when present in the body — preserve the existing partial-update semantics). Audit: the existing POLICY_UPDATE audit captures the change; ensure the new fields appear in its metadata if the route enumerates changed fields.

### C4 — UI card — locked
- Extend tenant-retention-policy-card.tsx with a toggle + numeric input per new field (clone the auditLogRetention block ×5), wired to GET hydrate + PATCH save + bindRangeInput([RETENTION_DAYS_MIN, RETENTION_DAYS_MAX]). Keep the card readable — consider a sub-section grouping ("Vault data" trash+history, "Logs" share-access+directory-sync+notification). Dirty-detection + save covers all fields.

### C5 — i18n — locked
- Add label/help/validation keys per field to messages/{en,ja}/TenantAdmin.json (clone the auditLogRetention* keys; ja non-katakana, 保管庫 for vault). Use {min}/{max} interpolation from the constants (R27 — no hardcoded numbers in strings).

### C6 — tests — locked
- Route test (src/app/api/tenant/policy/route.test.ts): GET returns the 5 fields; PATCH validates bounds (reject < min / > max / non-integer) and writes; null clears. Mirror the existing auditLogRetentionDays route tests.
- Card test (tenant-retention-policy-card.test.tsx): the 5 toggles+inputs hydrate from GET, save via PATCH, range-validate. Mirror the existing test.
- i18n interpolation test (tenant-admin-ttl-interpolation.test.ts if it enumerates retention keys): the new help/validation strings contain {min}/{max} (R27).

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | RETENTION_DAYS_MIN/MAX constants | locked |
| C2 | GET select + response | locked |
| C3 | PATCH validate + write + audit | locked |
| C4 | UI card (5 toggle+input) | locked |
| C5 | i18n en/ja | locked |
| C6 | route + card + i18n tests | locked |

## Considerations
- No worker change (columns + GC already shipped). This is purely the management surface.
- R27 (numeric-range-in-strings): help/validation strings use {min}/{max} placeholders sourced from the constants, not hardcoded.
- Out of scope: changing the worker's retention semantics; per-field different bounds.

## Scope contract
This is the final follow-up of the retention series. After this, tenant admins can configure all per-tenant retention windows; the worker enforces them.
