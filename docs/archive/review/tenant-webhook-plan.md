# Tenant-Level Webhooks

## Context

Currently webhooks are only available at the team scope (`TeamWebhook` model). Tenant-scoped audit events (ADMIN, SCIM, DIRECTORY_SYNC, BREAKGLASS) have no webhook delivery mechanism. This plan adds a `TenantWebhook` model with full CRUD API, dispatcher integration, and UI — enabling tenant admins to receive real-time notifications for organization-level events.

## Requirements

- New `TenantWebhook` Prisma model (separate from `TeamWebhook` for RLS isolation)
- Subscribe to tenant-scoped audit actions only
- OWNER/ADMIN only (new `WEBHOOK_MANAGE` tenant permission)
- Same security patterns as team webhooks: HMAC signing, HTTPS-only, FQDN validation, auto-disable after 10 failures
- Webhook dispatch at all tenant audit event call sites (~20 locations; VIEW/EXPIRE excluded)
- Management UI as a new tab in tenant settings

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Dispatcher | Generic shared internals + separate `dispatchTenantWebhook` export | Avoids ~100 lines duplication while keeping public API stable |
| Event dispatch pattern | Inline `void dispatchTenantWebhook(...)` at each call site | Matches existing team pattern; keeps audit and webhook coupling explicit |
| Webhook limit | `5` per scope (hardcoded constant) | Matches team; no per-tenant configurability needed yet |
| Audit actions | New `TENANT_WEBHOOK_CREATE/DELETE/DELIVERY_FAILED` | Distinct from team `WEBHOOK_*` for clean scope filtering |
| Event subscription | Restricted to `AUDIT_ACTION_GROUPS_TENANT` actions **excluding** `TENANT_WEBHOOK` group and `VIEW`/`EXPIRE` breakglass actions | Prevents self-referential loops and protects privacy-sensitive timing data |
| Payload sanitization | Webhook-specific `WEBHOOK_METADATA_BLOCKLIST` applied inside dispatcher before serialization | `sanitizeMetadata()` only strips crypto keys; webhook payloads also need to strip business PII (email, reason, incidentRef, targetUserEmail) |
| CSRF protection | `assertOrigin(req)` on POST handler | Prevents CSRF-based webhook registration attacks |

## Implementation Steps

### 1. Prisma Schema + Migration

**File:** `prisma/schema.prisma`

- Add enum values to `AuditAction`: `TENANT_WEBHOOK_CREATE`, `TENANT_WEBHOOK_DELETE`, `TENANT_WEBHOOK_DELIVERY_FAILED`
- Add `TenantWebhook` model (mirrors `TeamWebhook` structure, references `Tenant` with `onDelete: Cascade`):
  - Fields: `id`, `tenantId`, `url`, `secretEncrypted/Iv/AuthTag`, `masterKeyVersion`, `events[]`, `isActive`, `failCount`, `lastDeliveredAt/FailedAt`, `lastError`, timestamps
  - Index: `[tenantId]`, map: `tenant_webhooks`
- Add `tenantWebhooks TenantWebhook[]` back-relation to `Tenant` model
- Run `npm run db:migrate`

### 2. Constants & Types

**File:** `src/lib/constants/audit.ts`
- Add 3 actions to `AUDIT_ACTION` object and `AUDIT_ACTION_VALUES` array
- Add `TENANT_WEBHOOK: "group:tenantWebhook"` to `AUDIT_ACTION_GROUP`
- Add group to `AUDIT_ACTION_GROUPS_TENANT`
- Export `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` — flattened array of actions from `AUDIT_ACTION_GROUPS_TENANT` **excluding**:
  - `TENANT_WEBHOOK` group (prevents self-referential loops)
  - `PERSONAL_LOG_ACCESS_VIEW` and `PERSONAL_LOG_ACCESS_EXPIRE` (privacy-sensitive timing data; only `REQUEST` and `REVOKE` are subscribable)

**File:** `src/lib/constants/tenant-permission.ts`
- Add `WEBHOOK_MANAGE: "tenant:webhook:manage"`

**File:** `src/lib/constants/api-path.ts`
- Add `TENANT_WEBHOOKS: "/api/tenant/webhooks"` to `API_PATH`
- Add `tenantWebhooks()` and `tenantWebhookById(webhookId)` to `apiPath`

### 3. RBAC Update

**File:** `src/lib/tenant-auth.ts`
- Add `TENANT_PERMISSION.WEBHOOK_MANAGE` to OWNER and ADMIN sets in `ROLE_PERMISSIONS`

### 4. Dispatcher Refactoring

**File:** `src/lib/webhook-dispatcher.ts`

Extract shared internals, keep existing `dispatchWebhook` signature unchanged:

```
WebhookRecord (interface) — common fields: id, url, secret*, masterKeyVersion, failCount
dispatchToWebhooks(webhooks, payload, onSuccess, onFailure) — shared delivery loop
dispatchWebhook(event: TeamWebhookEvent)   — queries prisma.teamWebhook (unchanged API)
dispatchTenantWebhook(event: TenantWebhookEvent) — queries prisma.tenantWebhook (new)
```

Key details:
- `TenantWebhookEvent` uses `tenantId` instead of `teamId`
- Both functions use `withBypassRls` for queries (no RLS context at dispatch time)
- Add `User-Agent: passwd-sso-webhook/1.0` header in shared `deliverWithRetry()`
- Apply webhook-specific metadata sanitization to `event.data` before JSON serialization:
  - Extend `METADATA_BLOCKLIST` with business PII keys: `email`, `targetUserEmail`, `reason`, `incidentRef`, `displayName`
  - Define `WEBHOOK_METADATA_BLOCKLIST` in `src/lib/webhook-dispatcher.ts` (superset of `METADATA_BLOCKLIST`)
  - Apply sanitization inside both `dispatchWebhook` and `dispatchTenantWebhook` before `JSON.stringify`

### 5. API Routes

**`src/app/api/tenant/webhooks/route.ts`** (GET + POST)
- Auth: `requireTenantPermission(userId, TENANT_PERMISSION.WEBHOOK_MANAGE)`
- GET: list webhooks via `withTenantRls(prisma, actor.tenantId, ...)` — `select` clause must **exclude** `secretEncrypted`, `secretIv`, `secretAuthTag`, `masterKeyVersion`
- POST:
  - `assertOrigin(req)` at handler top (CSRF protection)
  - Validate URL (same schema as team) + events restricted to `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS`
  - Enforce 5/tenant limit
  - Generate HMAC secret, encrypt, create, audit log
  - Return `{ webhook, secret }` with `Cache-Control: no-store`

**`src/app/api/tenant/webhooks/[webhookId]/route.ts`** (DELETE)
- Auth: same permission check
- Find + delete via `withTenantRls`, audit log

### 6. Dispatch Integration (~20 call sites)

Add `void dispatchTenantWebhook(...)` after each `logAudit()` call:

| Group | Files | Actions |
|-------|-------|---------|
| ADMIN | `api/tenant/members/[userId]/reset-vault/route.ts` | ADMIN_VAULT_RESET_INITIATE |
| | `api/tenant/members/[userId]/reset-vault/[resetId]/revoke/route.ts` | ADMIN_VAULT_RESET_REVOKE |
| | `api/vault/admin-reset/route.ts` | ADMIN_VAULT_RESET_EXECUTE |
| | `api/tenant/members/[userId]/route.ts` | TENANT_ROLE_UPDATE (2 paths: ownership transfer + normal role change) |
| SCIM | `api/tenant/scim-tokens/route.ts` | SCIM_TOKEN_CREATE |
| | `api/tenant/scim-tokens/[tokenId]/route.ts` | SCIM_TOKEN_REVOKE |
| | `api/scim/v2/Users/route.ts` | SCIM_USER_CREATE |
| | `api/scim/v2/Users/[id]/route.ts` | SCIM_USER_UPDATE/DEACTIVATE/REACTIVATE/DELETE |
| | `api/scim/v2/Groups/[id]/route.ts` | SCIM_GROUP_UPDATE (PUT + PATCH) |
| DIR_SYNC | `api/directory-sync/route.ts` | CONFIG_CREATE |
| | `api/directory-sync/[id]/route.ts` | CONFIG_UPDATE, CONFIG_DELETE |
| | `api/directory-sync/[id]/run/route.ts` | SYNC_RUN |
| | `lib/directory-sync/engine.ts` | STALE_RESET |
| BREAKGLASS | `api/tenant/breakglass/route.ts` | PERSONAL_LOG_ACCESS_REQUEST |
| | `api/tenant/breakglass/[id]/route.ts` | PERSONAL_LOG_ACCESS_REVOKE |

**Excluded from dispatch:** `PERSONAL_LOG_ACCESS_VIEW` and `PERSONAL_LOG_ACCESS_EXPIRE` — these are privacy-sensitive timing signals and are not subscribable via tenant webhooks.

**SCIM routes note:** `tenantId` comes from `validateScimToken(req).data.tenantId`, not session.

### 7. UI

**New file:** `src/components/settings/tenant-webhook-card.tsx`
- Mirror `src/components/team/team-webhook-card.tsx` structure
- Event selector must use `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` (not raw `AUDIT_ACTION_GROUPS_TENANT`) to ensure UI options match API validation — VIEW/EXPIRE are excluded from both
- No `teamId` prop — tenant resolved server-side
- Fetch via `apiPath.tenantWebhooks()` / `apiPath.tenantWebhookById(webhookId)`
- `groupLabel` must include entries for `DIRECTORY_SYNC` and `BREAKGLASS` groups

**File:** `src/app/[locale]/dashboard/tenant/page.tsx`
- Add 5th tab `"webhooks"` with `<TenantWebhookCard />`
- Update grid: `grid-cols-2 md:grid-cols-5`

**i18n:** Add `TenantWebhook` section to `messages/en.json` and `messages/ja.json`, including:
- Group labels: `groupDirectorySync`, `groupBreakglass` (if not already present in `AuditLog` namespace)

### 8. Tests

**`src/lib/webhook-dispatcher.test.ts`**
- Extend `vi.hoisted` Prisma mock to include `tenantWebhook` model (`findMany`, `update`)
- Extend `vi.mock("@/lib/audit")` to re-export `sanitizeMetadata` via `vi.importActual` (otherwise it becomes `undefined` at runtime)
- Add `dispatchTenantWebhook` describe block:
  - Successful delivery + `lastDeliveredAt` update
  - HMAC correctness
  - Retry + `failCount` increment
  - `TENANT_WEBHOOK_DELIVERY_FAILED` audit event — **assert `scope: "TENANT"`, `tenantId`**, and **`expect(call[0]).not.toHaveProperty("teamId")`** (objectContaining alone is insufficient)
  - No-op when no matching webhooks
  - Auto-disable at `failCount >= 10`
  - Independent delivery to multiple webhooks
  - Never throws
  - `User-Agent` header is sent
  - `WEBHOOK_METADATA_BLOCKLIST` strips business PII from payload

**`src/app/api/tenant/webhooks/route.test.ts`** (GET + POST)
- GET: list webhooks, **assert secret fields excluded from response**
- POST: create webhook, limit enforcement, URL validation, auth, CSRF (`assertOrigin`)
- POST: **reject cross-scope events** (e.g., `events: ["ENTRY_CREATE"]` → 400)
- POST: **reject self-referential events** (e.g., `events: ["TENANT_WEBHOOK_CREATE"]` → 400)

**`src/app/api/tenant/webhooks/[webhookId]/route.test.ts`** (DELETE)
- Success, not-found, auth
- **Rethrows unexpected errors**

**`src/components/settings/tenant-webhook-card.test.tsx`**
- Mirror team webhook card tests
- **Assert `group:tenantWebhook` actions are not in event selector**

**Call-site integration tests** (at least 3 existing route tests):
- SCIM token route: mock `dispatchTenantWebhook`, assert called with correct `type`/`tenantId`
- Breakglass request route: same
- Tenant member role update route: same

## Considerations & Constraints

- **RLS**: `dispatchTenantWebhook` must use `withBypassRls` (fire-and-forget context has no RLS session)
- **SCIM routes** use token-based auth, not Auth.js — tenantId resolution differs
- **Self-referential prevention**: `TENANT_WEBHOOK_*` actions excluded from `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` at API validation level
- **Privacy**: VIEW/EXPIRE breakglass actions excluded from webhook subscription; webhook-specific `WEBHOOK_METADATA_BLOCKLIST` strips both crypto keys and business PII (email, reason, incidentRef) from payloads
- **CSRF**: `assertOrigin(req)` on POST to prevent attacker-controlled webhook registration
- **No event bus**: Follows existing fire-and-forget inline pattern; no pub/sub infrastructure needed

## Verification

1. `npm run db:migrate` — migration applies cleanly
2. `npx vitest run` — all tests pass (existing + new)
3. `npx next build` — production build succeeds
4. Manual: create tenant webhook via UI, trigger a tenant event (e.g., role update), verify HTTP delivery with signature
