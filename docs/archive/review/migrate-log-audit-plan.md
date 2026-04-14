# Plan: Bulk Migration of logAudit → logAuditAsync / logAuditInTx

## Project context

- **Type**: web app + service (Next.js 16 / Prisma 7 / PostgreSQL 16)
- **Test infrastructure**: unit tests (vitest) + integration tests (real Postgres) + CI/CD
- **Test obligations apply**: Major/Critical findings recommending tests are in scope.

## Objective

Complete the Phase 1 follow-up sweep: migrate all remaining `logAudit()` (fire-and-forget, void) and `logAuditBatch()` call sites to the durable audit path, then delete the deprecated functions.

**Why this matters**: `logAudit()` is fire-and-forget (`void logAuditAsync(...).catch(...)`) — if the process crashes or the event loop stalls before the outbox write completes, the audit entry is silently lost. The durable audit outbox (Phase 1) was introduced to guarantee F1 atomicity (business write ⇔ audit row), but only ~15 security-critical call sites were migrated. The remaining ~160 call sites still use the lossy path, leaving the Phase 1 objective incomplete.

**Parent design document**: [`durable-audit-outbox-plan.md`](./durable-audit-outbox-plan.md) (F10, L1058-1066, L925)

## Background — call site inventory

A full codebase survey identified the following categories:

| Category | Count | Migration target | Notes |
|----------|-------|-------------------|-------|
| A — Inside `prisma.$transaction` | **0** | `logAuditInTx(tx, tenantId, params)` | None found — all call sites fire after tx commits |
| B — Outside transaction (route handlers, lib) | **~152** | `await logAuditAsync(params)` | Main migration target |
| B2 — `logAuditBatch` call sites | **8** | Loop with `await logAuditAsync()` | Personal + team bulk ops |
| C — auth.ts (NextAuth callbacks) | **2** | `await logAuditAsync(params)` | AUTH_LOGIN / AUTH_LOGOUT — NextAuth events support async |
| D — Test files | **11** | Update to test new API | `audit.mocked.test.ts`, integration tests |
| E — webhook-dispatcher.ts | **2** | `await logAuditAsync()` via dynamic import | Preserve lazy import for circular dep |

**Key finding**: No `logAudit()` calls exist inside `prisma.$transaction()` callbacks. Every call follows the pattern: transaction completes → `logAudit()` fires outside. Therefore the bulk migration target is `logAuditAsync`, not `logAuditInTx`.

## Requirements

### Functional

| # | Requirement |
|---|---|
| MF1 | Enhance `logAuditAsync` to emit structured JSON to `auditLogger` (currently only `logAudit` does this). After migration, structured log forwarding must continue working. **tenantId handling**: emit `params.tenantId ?? null` (pre-resolution value) in structured JSON. This preserves emit-first ordering while including tenantId when the caller provides it. Callers that already pass `tenantId` (tenant/admin endpoints) will have it in the emit; callers that rely on `resolveTenantId` will emit `null` (same as current `logAudit` behavior). |
| MF2 | `logAuditAsync` must catch all errors internally and log to `deadLetterLogger` — callers should not need try/catch. The function never throws. **Dead letter sanitization**: before logging to `deadLetterLogger`, apply `sanitizeMetadata(params.metadata)` to prevent raw metadata (which may contain sensitive data) from reaching stdout. Log only `{ scope, action, userId, tenantId, reason, error }` — not the full `auditEntry: params`. |
| MF3 | Replace all ~152 `logAudit(params)` calls with `await logAuditAsync(params)`. |
| MF4 | Replace all 8 `logAuditBatch(list)` calls with `for (const p of list) { await logAuditAsync(p); }` or equivalent. |
| MF5 | Delete `logAudit()` and `logAuditBatch()` from `src/lib/audit.ts`. Remove `@deprecated` annotations. |
| MF6 | Update 2 webhook-dispatcher.ts call sites: change dynamic import target from `logAudit` to `logAuditAsync`, add `await`. Preserve the lazy `await import(...)` pattern to avoid circular dependency. **Fix TEAM scope site** (L231): change `userId: "system"` to `userId: NIL_UUID` so the call follows the normal outbox path (avoids dead letter when `tenantId` is not provided for TEAM-scope webhook failures). Import `NIL_UUID` from `@/lib/constants/app`. |
| MF7 | Migrate auth.ts AUTH_LOGIN / AUTH_LOGOUT (2 sites) to `await logAuditAsync(params)`. NextAuth v5 `events` callbacks accept async functions — the `await` ensures the outbox write completes before the callback returns. This is strictly better than fire-and-forget and resolves the original DEFERRED status. |
| MF8 | Update test files to test `logAuditAsync` instead of `logAudit`. |
| MF9 | Remove `logAuditBatch` export and any re-exports. |
| MF10 | Any call site using string literals for `scope` or `action` instead of enum constants must be fixed during migration. |

### Non-functional

| # | Requirement |
|---|---|
| MN1 | No behavioral change to end users — audit events continue to be written to the outbox and forwarded. |
| MN2 | Response latency impact: `await logAuditAsync()` adds ~1-5ms per request (single outbox INSERT). Acceptable for all endpoints. |
| MN3 | All existing tests must pass after migration. Build must succeed. |
| MN4 | The structured JSON emit to `auditLogger` must remain synchronous within `logAuditAsync` — it must not depend on the outbox write succeeding. |

## Technical approach

### 1. Enhance `logAuditAsync` in `src/lib/audit.ts`

Current `logAuditAsync`:
```typescript
export async function logAuditAsync(params: AuditLogParams): Promise<void> {
  const payload = buildOutboxPayload(params);
  // ... tenantId resolution, outbox enqueue
  // Does NOT emit structured JSON
  // Does NOT catch errors
}
```

After enhancement:
```typescript
export async function logAuditAsync(params: AuditLogParams): Promise<void> {
  const payload = buildOutboxPayload(params);

  // Structured JSON emit FIRST (synchronous, never fails the caller)
  // tenantId uses pre-resolution value (params.tenantId ?? null)
  try {
    auditLogger.info(
      {
        audit: {
          scope: payload.scope,
          action: payload.action,
          userId: payload.userId,
          actorType: payload.actorType,
          serviceAccountId: payload.serviceAccountId,
          tenantId: params.tenantId ?? null,
          teamId: payload.teamId,
          targetType: payload.targetType,
          targetId: payload.targetId,
          metadata: sanitizeMetadata(payload.metadata),
          ip: payload.ip,
          userAgent: payload.userAgent,
        },
      },
      `audit.${payload.action}`,
    );
  } catch {
    // Never let forwarding break the app
  }

  // Outbox enqueue (awaited, ALL errors caught — MF2 "never throws")
  try {
    // Non-UUID userId path — dead letter output also sanitized
    if (!UUID_RE.test(params.userId)) {
      const tenantId = params.tenantId ?? null;
      if (!tenantId) {
        deadLetterLogger.warn(
          { scope: params.scope, action: params.action, userId: params.userId,
            reason: "non_uuid_userId_no_tenantId" },
          "audit.dead_letter",
        );
        return;
      }
      // ... direct auditLog.create (unchanged)
      return;
    }

    // Normal path: resolve tenantId, enqueue to outbox
    const tenantId = await resolveTenantId(params);
    if (!tenantId) {
      deadLetterLogger.warn(
        { scope: params.scope, action: params.action, userId: params.userId,
          reason: "tenant_not_found" },
        "audit.dead_letter",
      );
      return;
    }
    await enqueueAudit(tenantId, payload);
  } catch (err) {
    // Outer catch: resolveTenantId or enqueueAudit failure
    deadLetterLogger.warn(
      { scope: params.scope, action: params.action, userId: params.userId,
        tenantId: params.tenantId ?? null,
        reason: "logAuditAsync_failed", error: String(err) },
      "audit.dead_letter",
    );
  }
}
```

**Design decisions**:
- Structured JSON is emitted FIRST (synchronous, no await) so it's never lost even if outbox write fails
- `tenantId` in structured emit uses `params.tenantId ?? null` (pre-resolution) — callers that pass `tenantId` will have it; callers that rely on `resolveTenantId` will emit `null` (matches current `logAudit` behavior)
- Dead letter output is sanitized: only `{ scope, action, userId, tenantId, reason, error }` — raw `metadata` is never logged to prevent sensitive data leakage
- Error catching is inside `logAuditAsync` so callers don't need try/catch
- The function never throws — `await logAuditAsync()` always resolves

### 2. Migration patterns

#### Pattern B1: Simple replacement (majority of call sites)

```typescript
// Before
logAudit({
  scope: AUDIT_SCOPE.PERSONAL,
  action: AUDIT_ACTION.ENTRY_CREATE,
  userId, ip, userAgent,
  ...
});

// After
await logAuditAsync({
  scope: AUDIT_SCOPE.PERSONAL,
  action: AUDIT_ACTION.ENTRY_CREATE,
  userId, ip, userAgent,
  ...
});
```

#### Pattern B2: logAuditBatch replacement

```typescript
// Before
logAuditBatch(auditEntries);

// After
for (const entry of auditEntries) {
  await logAuditAsync(entry);
}
```

Note: Sequential await is preferred over `Promise.all` because:
- Each `logAuditAsync` opens its own transaction to the outbox
- Sequential writes are more predictable under load
- Count is small (typically < 50 entries in bulk ops)

#### Pattern B3: Dual-scope audit (delegation, MCP tools)

```typescript
// Before
logAudit({ ...auditBase, scope: AUDIT_SCOPE.PERSONAL });
logAudit({ ...auditBase, scope: AUDIT_SCOPE.TENANT });

// After
await logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.PERSONAL });
await logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.TENANT });
```

#### Pattern E: Webhook dispatcher (dynamic import)

```typescript
// Before
const { logAudit } = await import("@/lib/audit");
logAudit({ ... });

// After
const { logAuditAsync } = await import("@/lib/audit");
await logAuditAsync({ ... });
```

The lazy `await import(...)` MUST be preserved — it breaks the circular dependency between `audit.ts` ↔ `webhook-dispatcher.ts`.

### 3. Deletion of deprecated functions

After all call sites are migrated:

1. Delete `logAudit()` function (L213-263)
2. Delete `logAuditBatch()` function (L273-279)
3. Remove `@deprecated` JSDoc from `logAuditAsync` if present
4. Clean up any unused imports that were only needed by the deleted functions

### 4. Test updates

#### `src/__tests__/audit.mocked.test.ts`

- Replace all `logAudit(...)` calls with `await logAuditAsync(...)`
- Test that `logAuditAsync` emits structured JSON to `auditLogger`
- Test that `logAuditAsync` catches errors and logs to `deadLetterLogger`
- Test that `logAuditAsync` never throws

#### `src/__tests__/integration/audit-and-isolation.test.ts`

- Replace all `logAudit(...)` calls with `await logAuditAsync(...)`
- Integration tests already verify outbox behavior — migration should be transparent

### 5. Special cases

| Call site | Handling |
|-----------|----------|
| `src/auth.ts:338,350` | Migrate to `await logAuditAsync()` — NextAuth v5 events support async callbacks |
| `src/app/api/share-links/verify-access/route.ts:75,90` | `userId: "anonymous"` (non-UUID) — `logAuditAsync` already handles this path |
| `src/lib/account-lockout.ts:284,317,366` | Fallback paths where tenantId is null — `logAuditAsync` handles via `resolveTenantId` |
| `src/app/api/mcp/register/route.ts:172` | `userId: NIL_UUID`, `actorType: "SYSTEM"` — `logAuditAsync` handles non-UUID path |
| `src/app/api/internal/audit-emit/route.ts:46` | Dynamic action — works with `logAuditAsync` as-is |
| `src/lib/webhook-dispatcher.ts:231,302` | Dynamic import — change import target, add await. **L231 (TEAM scope)**: fix `userId: "system"` → `NIL_UUID` to avoid dead letter (non-UUID + no tenantId → dropped). **L302 (TENANT scope)**: keep `userId: "system"` — `tenantId: event.tenantId` is provided, so the non-UUID direct-write path works correctly. `AuditLog.userId` is nullable with no FK constraint, so `userId: "system"` is stored as-is. |
| `src/app/api/vault/setup/route.ts` etc. | String literals for scope/action — fix to use constants (MF10) |

## Implementation steps

### Step 1: Enhance `logAuditAsync` (src/lib/audit.ts)

1. Add structured JSON emit to `logAuditAsync` (move from `logAudit`) — emit FIRST before outbox write
2. Wrap the **entire body** (including `resolveTenantId` + `enqueueAudit`) in a single outer try/catch with `deadLetterLogger` — MF2 "never throws" requires catching ALL errors, not just `enqueueAudit`
3. Sanitize all dead letter outputs (3 paths: `non_uuid_userId_no_tenantId`, `tenant_not_found`, outer catch) — log only `{ scope, action, userId, tenantId, reason, error }`, never raw `metadata`
4. Ensure the function never throws

**Step 1 and Step 10a/10b MUST be in the same commit** — modifying `logAuditAsync` to never-throw will break `audit-fifo-flusher.test.ts` L153-168 (`rejects.toThrow`). Both the implementation change and the test update must land atomically.

### Step 2: Migrate `src/lib/` call sites (~15 files)

Migrate in order:
1. `src/lib/access-restriction.ts` (3 sites)
2. `src/lib/team-policy.ts` (1 site)
3. `src/lib/auth-adapter.ts` (2 sites)
4. `src/lib/account-lockout.ts` (3 sites)
5. `src/lib/delegation.ts` (4 sites)
6. `src/lib/directory-sync/engine.ts` (1 site)
7. `src/lib/mcp/tools.ts` (2 sites)
8. `src/lib/webhook-dispatcher.ts` (2 sites — dynamic import pattern)

### Step 3: Migrate personal route handlers (~50 files)

Migrate all `src/app/api/` route handlers that use PERSONAL scope:
- passwords (CRUD, bulk, attachments, history)
- folders, tags
- vault (setup, reset, rotate-key, recovery-key, delegation)
- sessions
- api-keys
- webauthn
- emergency-access
- travel-mode
- audit-logs (export, download, import)
- sends
- watchtower
- extension
- auth/passkey/verify

### Step 4: Migrate tenant/admin route handlers (~25 files)

- tenant/policy, tenant/members, tenant/breakglass
- tenant/service-accounts (CRUD, tokens)
- tenant/access-requests (CRUD, approve, deny)
- tenant/webhooks
- tenant/scim-tokens
- tenant/mcp-clients
- tenant/audit-delivery-targets
- tenant/audit-logs/download
- admin/rotate-master-key
- maintenance/* (purge-audit-logs, purge-history, dcr-cleanup, audit-outbox-*, audit-chain-verify)
- scim/v2 (Users, Groups)
- directory-sync (CRUD, run)
- mcp (register, token, authorize/consent)
- internal/audit-emit

### Step 5: Migrate team route handlers (~20 files)

- teams/[teamId]/passwords (CRUD, bulk, attachments, history)
- teams/[teamId]/folders
- teams/[teamId]/members
- teams/[teamId]/invitations
- teams/[teamId]/webhooks
- teams/[teamId]/policy
- teams/[teamId]/rotate-key
- teams/[teamId]/audit-logs/download

### Step 6: Migrate logAuditBatch call sites (8 files)

- passwords/bulk-import, bulk-restore, bulk-trash, bulk-archive
- teams/[teamId]/passwords/bulk-import, bulk-restore, bulk-trash, bulk-archive

### Step 7: Update import statements

- Change `import { logAudit, ... }` to `import { logAuditAsync, ... }` in all migrated files
- Remove `logAuditBatch` from all imports

### Step 8: Delete deprecated functions

- Remove `logAudit()` from `src/lib/audit.ts`
- Remove `logAuditBatch()` from `src/lib/audit.ts`
- Clean up unused imports in `audit.ts`

### Step 9: Migrate auth.ts (AUTH_LOGIN / AUTH_LOGOUT)

- Replace `logAudit(params)` with `await logAuditAsync(params)` in both `events.signIn` and `events.signOut` callbacks
- NextAuth v5 `events` callbacks support async functions — `await` ensures the outbox write completes
- Import `logAuditAsync` from `@/lib/audit`, remove `logAudit` import
- This resolves the original DEFERRED status from Phase 1 (design doc L1065-1066)

### Step 10: Update tests (immediately after Step 1)

**NOTE**: Test updates for `logAuditAsync` behavior (Step 10a) must run immediately after Step 1 to verify MF1/MF2 implementation before proceeding with bulk migration.

#### Step 10a: `src/__tests__/audit.mocked.test.ts` (same commit as Step 1)

- **Rewrite** the existing `describe("logAudit", ...)` block (L36-183) to test `logAuditAsync` instead — these tests must be converted, not merely supplemented, because `logAudit` will be deleted in Step 8
- Replace all `logAudit(...)` calls with `await logAuditAsync(...)`
- Add/update test cases:
  1. `logAuditAsync` calls `auditLogger.info` with structured audit payload (MF1)
  2. `logAuditAsync` includes `tenantId` in structured emit when provided
  3. `enqueueAudit` throws → `logAuditAsync` resolves (not rejects) + `deadLetterLogger` called (MF2)
  4. `auditLogger.info` throws → `logAuditAsync` still resolves (MN4)
  5. Dead letter output does not contain raw `metadata` (S2 fix)
  6. `expect(mockEnqueueAudit).toHaveBeenCalled()` for normal flow (T3 fix)

#### Step 10b: `src/__tests__/audit-fifo-flusher.test.ts` (same commit as Step 1)

- **Rewrite L153-168**: change `rejects.toThrow(...)` to `expect(logAuditAsync(...)).resolves.toBeUndefined()` + `expect(deadLetterLogger.warn).toHaveBeenCalled()` (T4 fix — current test contradicts MF2)
- Add `auditLogger.info` mock and assertion (change mock `enabled: true` if needed — no guard in code, but pino may check it)

#### Step 10c: `src/__tests__/integration/audit-and-isolation.test.ts` (after Step 8)

- Replace `logAudit` mock with `logAuditAsync` mock
- Note: this file uses mocks and does not test real outbox behavior. Real outbox testing is in `src/__tests__/db-integration/` tests (out of scope for this migration).

#### Step 10d: Other test files (after Step 6)

- Grep for `logAuditBatch` in all test files including `bulk-*.route.test.ts` — update imports and calls
- Verify no remaining `logAudit` or `logAuditBatch` imports in any test file

### Step 11: Verification

1. `npx vitest run` — all tests pass
2. `npx next build` — production build succeeds
3. Grep for remaining `logAudit(` calls — should only find `logAuditAsync` and `logAuditInTx`
4. Add residual-logAudit check to `scripts/pre-pr.sh`: use `if grep -rn 'logAudit(' src/ --include='*.ts' | grep -v 'logAuditAsync\|logAuditInTx' | grep -v test | grep -q .; then echo "ERROR: residual logAudit calls found"; exit 1; fi` pattern (not bare grep, which fails with exit code 1 on zero matches under `set -euo pipefail`)

## Testing strategy

| Test | Type | What it verifies |
|------|------|-----------------|
| `audit.mocked.test.ts` | Unit (mocked) | `logAuditAsync` emits structured JSON (MF1), catches errors (MF2), dead letter sanitized (S2), never throws (MN4), outbox called (T3) |
| `audit-fifo-flusher.test.ts` | Unit (mocked) | `logAuditAsync` error → resolves (not rejects) + deadLetter (T4 rewrite), auditLogger emit |
| `audit-and-isolation.test.ts` | Unit (mocked) | Mock-based isolation verification (note: does NOT test real outbox) |
| Build verification | `next build` | All imports resolve, no type errors |
| Grep verification | `pre-pr.sh` + manual | No remaining `logAudit(` calls (except `logAuditAsync`/`logAuditInTx`) |

## Considerations & constraints

### Performance impact

- `await logAuditAsync()` adds ~1-5ms per request for the outbox INSERT
- For batch operations (bulk-import with many entries), sequential awaits may add noticeable latency
- Mitigation: batch operations already have high latency; audit overhead is negligible relative to the business operation

### auth.ts — fully migrated (no longer DEFERRED)

- Original plan deferred AUTH_LOGIN/AUTH_LOGOUT because `logAuditInTx` requires a transaction scope
- Since we're using `logAuditAsync` (self-contained transaction), we CAN fully migrate these sites
- NextAuth v5 `events` callbacks accept async functions — `await logAuditAsync(params)` ensures the outbox write completes before the callback returns
- This is strictly better than `logAudit()` because: (1) outbox write is awaited (no silent loss on process shutdown), (2) errors go to `deadLetterLogger` instead of being silently swallowed
- AUTH_LOGIN / AUTH_LOGOUT are the most audit-critical events — fire-and-forget is unacceptable for compliance (SOC 2, ISO 27001)

### Webhook dispatcher circular dependency

- `audit.ts` imports from `webhook-dispatcher.ts` (for webhook dispatch on audit events)
- `webhook-dispatcher.ts` imports from `audit.ts` (to log delivery failures)
- The lazy `await import("@/lib/audit")` in webhook-dispatcher.ts breaks this cycle
- This pattern MUST be preserved during migration

### Out of scope

- Moving any call site INTO a `prisma.$transaction` for atomicity (that's a separate future effort)
- Changing the `logAuditInTx` API or behavior
- Modifying the outbox worker
- Adding new audit actions or changing existing ones

## User operation scenarios

### Scenario 1: Normal API request with audit

1. User creates a password entry via POST /api/passwords
2. Route handler creates the entry in a transaction
3. After transaction commits, `await logAuditAsync(params)` writes to outbox
4. Response is sent to user
5. Worker picks up outbox row and writes to audit_logs

**Change from current**: Step 3 now awaits instead of fire-and-forget. If the outbox write fails, the error is logged to deadLetterLogger but the response still succeeds.

### Scenario 2: Bulk operation with multiple audit entries

1. User bulk-imports 50 password entries via POST /api/passwords/bulk-import
2. Entries are created in a transaction
3. 50 `await logAuditAsync()` calls execute sequentially
4. Response is sent

**Performance**: ~50-250ms additional latency from sequential outbox writes. Acceptable for a bulk operation.

### Scenario 3: Auth login (NextAuth callback)

1. User signs in via Google OIDC
2. NextAuth triggers `events.signIn` callback (async)
3. `await logAuditAsync(params)` writes AUTH_LOGIN to outbox
4. Callback returns, auth flow completes

**Change from current**: Now awaits `logAuditAsync` (durable, errors caught) instead of `logAudit` (fire-and-forget, errors swallowed). Auth events are fully durable.

### Scenario 4: Webhook delivery failure audit

1. Webhook delivery fails
2. webhook-dispatcher.ts dynamically imports `logAuditAsync`
3. `await logAuditAsync({ action: WEBHOOK_DELIVERY_FAILED, ... })` writes to outbox
4. The action is in `OUTBOX_BYPASS_AUDIT_ACTIONS` — worker writes directly to audit_logs, skipping re-dispatch

**Change from current**: Same behavior but with `await` for durability.
