# Plan: Audit Delivery Target CRUD API + UI

## Project Context

- **Type**: web app (Next.js 16 App Router + Prisma 7 + PostgreSQL 16)
- **Test infrastructure**: unit + integration (Vitest, real-DB integration tests)

## Objective

Implement tenant-scoped CRUD endpoints and admin UI for managing `AuditDeliveryTarget` rows. This allows tenant admins to configure where audit events are delivered (webhook, SIEM HEC, S3). The DB schema, RLS policies, and worker grants already exist (Phase 3). This task adds the management layer.

## Requirements

### Functional

- **FR-1**: `GET /api/tenant/audit-delivery-targets` — List all delivery targets for the tenant (omit encrypted config fields)
- **FR-2**: `POST /api/tenant/audit-delivery-targets` — Create a new delivery target with kind + config. Config is encrypted server-side (AES-256-GCM + master key versioning). Max 10 targets per tenant (count includes all targets regardless of isActive status, matching existing webhook pattern).
- **FR-3**: `PATCH /api/tenant/audit-delivery-targets/[id]` — Toggle `isActive` (deactivate: set false, reactivate: set true). No physical delete (P3-F5 constraint: delivery history references targets via onDelete: Restrict).
- **FR-4**: Admin UI page at `/admin/tenant/audit-logs/delivery` showing target list, create form (kind picker + kind-specific config fields), and deactivate/reactivate toggle buttons.
- **FR-5**: Audit actions logged for all mutations:
  - `AUDIT_DELIVERY_TARGET_CREATE` — on POST
  - `AUDIT_DELIVERY_TARGET_DEACTIVATE` — on PATCH when isActive toggled to false
  - `AUDIT_DELIVERY_TARGET_REACTIVATE` — on PATCH when isActive toggled to true

### Non-Functional

- **NFR-1**: Follow existing `/api/tenant/webhooks` pattern exactly (auth, CSRF, RLS, error handling, request logging)
- **NFR-2**: Config encryption uses `encryptServerData` / master key versioning (same as `TenantWebhook.secretEncrypted`)
- **NFR-3**: New permission `AUDIT_DELIVERY_MANAGE` — granted to OWNER and ADMIN roles (same level as WEBHOOK_MANAGE)
- **NFR-4**: Config blob is never returned to the client — only `kind`, `isActive`, `failCount`, `lastError`, `lastDeliveredAt`, `createdAt` are exposed
- **NFR-5**: i18n: full EN + JA translations
- **NFR-6**: SSRF guard on URL fields (WEBHOOK.url, SIEM_HEC.url) — same HTTPS-only + private IP block as existing webhook schema

## Technical Approach

### Config Blob Schema (per kind)

The `configEncrypted` field stores a JSON blob. The shape depends on `kind`:

```typescript
// WEBHOOK
{ url: string; secret?: string }

// SIEM_HEC
{ url: string; token: string; index?: string; sourcetype?: string }

// S3_OBJECT
{ bucket: string; region: string; accessKeyId: string; secretAccessKey: string; prefix?: string }
```

Validation is done via discriminated Zod union on `kind` before encryption. URL fields in WEBHOOK and SIEM_HEC kinds include SSRF refine (HTTPS only, no localhost/private IPs) matching the existing webhook URL validation pattern.

### API Design

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tenant/audit-delivery-targets` | GET | List targets (no config) |
| `/api/tenant/audit-delivery-targets` | POST | Create target |
| `/api/tenant/audit-delivery-targets/[id]` | PATCH | Toggle isActive (deactivate/reactivate) |

No PUT (config is write-once; to change config, deactivate and create new).
No DELETE (soft-delete only via PATCH isActive=false).

### Permission

New `TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE = "tenant:auditDelivery:manage"`.

Granted to OWNER and ADMIN roles in `ROLE_PERMISSIONS` (`src/lib/tenant-auth.ts`). This follows the same pattern as `WEBHOOK_MANAGE`.

### UI Placement

Add to admin sidebar under "Audit Logs" group as a third child:
```
Audit Logs
  ├── Logs
  ├── Break Glass
  └── Delivery        ← NEW
```

Route: `/admin/tenant/audit-logs/delivery`

The UI is a standalone card component (not reusing `BaseWebhookCard` — the config form is kind-specific, unlike the webhook URL+events pattern).

## Implementation Steps

### Step 1: Schema & Constants

1.1. Add `AUDIT_DELIVERY_TARGET_CREATE`, `AUDIT_DELIVERY_TARGET_DEACTIVATE`, and `AUDIT_DELIVERY_TARGET_REACTIVATE` to `AuditAction` enum in `prisma/schema.prisma`
1.2. Add corresponding entries to `AUDIT_ACTION` constant in `src/lib/constants/audit.ts`
1.3. Add to `AUDIT_ACTION_VALUES` array in `src/lib/constants/audit.ts`
1.4. Add `AUDIT_DELIVERY_TARGET` group to `AUDIT_ACTION_GROUP` in `src/lib/constants/audit.ts`
1.5. Add `AUDIT_DELIVERY_TARGET` group entries to `AUDIT_ACTION_GROUPS_TENANT` in `src/lib/constants/audit.ts`
1.6. Add `AUDIT_DELIVERY_TARGET_CREATE`, `_DEACTIVATE`, `_REACTIVATE` to `WEBHOOK_DISPATCH_SUPPRESS` in `src/lib/constants/audit.ts` (prevent re-entrant dispatch — R13). Do NOT add to `OUTBOX_BYPASS_AUDIT_ACTIONS` (these are user-originated CRUD actions, not worker-originated SYSTEM events).
1.7. Add `AUDIT_DELIVERY_MANAGE` to `TENANT_PERMISSION` in `src/lib/constants/tenant-permission.ts`
1.8. Add `AUDIT_DELIVERY_MANAGE` to OWNER and ADMIN sets in `ROLE_PERMISSIONS` in `src/lib/tenant-auth.ts`
1.9. Add `TENANT_AUDIT_DELIVERY_TARGETS` to `API_PATH` and helpers to `apiPath` in `src/lib/constants/api-path.ts`
1.10. Add `MAX_AUDIT_DELIVERY_TARGETS = 10` to `src/lib/validations/common.ts`
1.11. Add i18n keys for group label to `messages/en/AuditLog.json` and `messages/ja/AuditLog.json`
1.12. Add i18n keys for sidebar nav to `messages/en/AdminConsole.json` and `messages/ja/AdminConsole.json`

### Step 2: Prisma Migration

2.1. Create migration to add `AUDIT_DELIVERY_TARGET_CREATE`, `AUDIT_DELIVERY_TARGET_DEACTIVATE`, and `AUDIT_DELIVERY_TARGET_REACTIVATE` to `AuditAction` PostgreSQL enum via `ALTER TYPE "AuditAction" ADD VALUE`
2.2. Run `npx prisma generate` to regenerate the Prisma Client with new enum values

### Step 3: API Route Handlers

3.1. Create `src/app/api/tenant/audit-delivery-targets/route.ts` with GET and POST handlers
  - GET: `auth()` → `requireTenantPermission(AUDIT_DELIVERY_MANAGE)` → `withTenantRls` → `findMany` (select without config fields) → return JSON
  - POST: `assertOrigin(req)` (CSRF) → `auth()` → `requireTenantPermission(AUDIT_DELIVERY_MANAGE)` → `parseBody(req, schema)` → count limit check (all targets, regardless of isActive) → `encryptServerData(JSON.stringify(config), masterKey)` → `create` → `logAudit(AUDIT_DELIVERY_TARGET_CREATE)` → return JSON (201, no config)
  - Zod schema: discriminated union on `kind` with SSRF refine on WEBHOOK.url and SIEM_HEC.url (same pattern as existing webhook createWebhookSchema)
3.2. Create `src/app/api/tenant/audit-delivery-targets/[id]/route.ts` with PATCH handler
  - `assertOrigin(req)` (CSRF) → `auth()` → `requireTenantPermission(AUDIT_DELIVERY_MANAGE)` → `withTenantRls` → `findFirst` (verify ownership) → `update({ isActive })` → `logAudit(isActive ? AUDIT_DELIVERY_TARGET_REACTIVATE : AUDIT_DELIVERY_TARGET_DEACTIVATE)` → return JSON

### Step 4: i18n Files

4.1. Create `messages/en/AuditDeliveryTarget.json` with all UI strings
4.2. Create `messages/ja/AuditDeliveryTarget.json` with all UI strings

### Step 5: Admin UI

5.1. Add sidebar nav entry in `src/components/admin/admin-sidebar.tsx` (add `Send` icon import from lucide-react)
5.2. Update `src/components/admin/admin-sidebar.test.tsx` — update link count (20 → 22) and add `/admin/tenant/audit-logs/delivery` to expectedHrefs
5.3. Create page at `src/app/[locale]/admin/tenant/audit-logs/delivery/page.tsx`
5.4. Create `src/components/settings/audit-delivery-target-card.tsx` component with:
  - Target list (kind badge, active/inactive status, failCount, lastError, lastDeliveredAt)
  - Create form with kind selector and dynamic config fields per kind
  - Deactivate/Reactivate toggle buttons with confirmation dialog (AlertDialog)

### Step 6: Unit Tests

6.1. Create `src/app/api/tenant/audit-delivery-targets/route.test.ts` (GET + POST)
  - Test cases: auth 401, permission 403, CSRF block on POST, successful GET (verify config fields excluded), successful POST, POST count limit (10), POST with inactive targets in count, POST validation errors (invalid kind, missing required fields, SSRF URL rejection)
  - Use `AUDIT_ACTION.AUDIT_DELIVERY_TARGET_CREATE` constants (not string literals)
6.2. Create `src/app/api/tenant/audit-delivery-targets/[id]/route.test.ts` (PATCH)
  - Test cases: auth 401, permission 403, CSRF block, not found 404, successful deactivate (isActive false → logAudit DEACTIVATE), successful reactivate (isActive true → logAudit REACTIVATE)

### Step 7: Verification

7.1. Run `npx vitest run`
7.2. Run `npx next build`

## Testing Strategy

- **Unit tests**: Mock-based tests for route handlers following `src/app/api/tenant/webhooks/route.test.ts` pattern. Use AUDIT_ACTION constants (not string literals) for audit action assertions.
- **Integration tests**: Existing integration tests cover DB role grants and RLS policies on `audit_delivery_targets` table only (not app-role CRUD). New API endpoints are additive and do not change worker behavior. App-role CRUD integration testing is out of scope for this task.
- **Manual verification**: Create/list/deactivate/reactivate targets via the admin UI

## Considerations & Constraints

- **No physical delete**: `AuditDelivery` rows reference `AuditDeliveryTarget` with `onDelete: Restrict`. Deactivation via `isActive = false` is the only option.
- **Config is write-once**: No update endpoint for config. Changing config requires deactivate + create new. This avoids complexity of partial config updates and re-encryption.
- **DB kind (AuditDeliveryTargetKind.DB)**: The `DB` kind is the built-in default (audit_logs table). It does not appear in the CRUD UI — it's managed internally by the worker. The UI only shows WEBHOOK, SIEM_HEC, S3_OBJECT.
- **No secret return**: Unlike webhooks (which return the HMAC secret once on create), delivery target configs contain full credentials. The config is never returned to the client after creation.
- **Dispatch suppression**: All three audit actions are added to `WEBHOOK_DISPATCH_SUPPRESS` only (not `OUTBOX_BYPASS_AUDIT_ACTIONS`, which is reserved for worker-originated SYSTEM events). This prevents delivery of management events through the delivery pipeline (R13 prevention).
- **Count limit scope**: The 10-target limit counts all targets regardless of isActive status, matching the existing webhook pattern (which counts all webhooks regardless of state).

## User Operation Scenarios

1. **Create WEBHOOK target**: Admin navigates to Audit Logs > Delivery, selects "Webhook" kind, enters HTTPS URL (SSRF-validated), optionally enters HMAC secret, clicks Create. Target appears in list as active.
2. **Create SIEM HEC target**: Admin selects "Splunk HEC", enters collector HTTPS URL (SSRF-validated), HEC token, optional index/sourcetype. Create succeeds.
3. **Create S3 target**: Admin selects "S3", enters bucket, region, access key ID, secret access key, optional prefix.
4. **Deactivate target**: Admin clicks deactivate on an active target. Confirmation dialog shown. After confirm, target moves to inactive section. Audit log records AUDIT_DELIVERY_TARGET_DEACTIVATE.
5. **Reactivate target**: Admin clicks reactivate on an inactive target. Target moves back to active section, worker resumes delivery. Audit log records AUDIT_DELIVERY_TARGET_REACTIVATE.
6. **Limit reached**: Admin tries to create 11th target (including inactive ones). UI shows limit-reached message, create form is disabled.
7. **Permission denied**: Non-admin user navigates to the page. Permission check returns 403.
