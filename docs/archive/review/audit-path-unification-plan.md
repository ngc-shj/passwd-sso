# Plan: Full Audit Path Unification via Sentinel UUID + ANONYMOUS ActorType

## Project context

- **Type**: web app + service (Next.js 16 / Prisma 7 / PostgreSQL 16)
- **Test infrastructure**: unit tests (vitest) + integration tests (real Postgres) + E2E (Playwright) + CI/CD
- **Test obligations apply**: Major/Critical findings recommending tests are in scope.

## Objective

Eliminate the remaining non-outbox audit write path for anonymous / SYSTEM application events by introducing:

1. A new `ActorType.ANONYMOUS` enum value to distinguish unauthenticated-actor events from worker-emitted SYSTEM events
2. Two sentinel UUIDs (`ANONYMOUS_ACTOR_ID`, `SYSTEM_ACTOR_ID`) that replace `userId: null` in application code
3. Removal of the `audit_logs.userId → users.id` FK constraint to decouple audit records from user lifecycle
4. Tightening of `audit_logs.userId` back to `NOT NULL` (since sentinels fill the previously-null slot)
5. Worker guard migration: reject null userId always, but accept ANONYMOUS/SYSTEM sentinels through the normal outbox pipeline

After this change, **all application-emitted audit events flow through the outbox** (path 1). Worker meta-events remain on `writeDirectAuditLog` (path 3, unchanged — required to record the outbox's own failures). Path 2 (the null-userId direct-write branch in `logAuditAsync`) is **deleted**.

## Background

### Parent thread

- PR #375 unified `logAudit*` into `logAuditAsync` and introduced the `userId: null + actorType: SYSTEM → direct write` path for anonymous share-access events.
- External reviewer flagged: "still not fully unified — anonymous events bypass the outbox, which means no SIEM fan-out for `SHARE_ACCESS_VERIFY_FAILED` (a brute-force signal)."
- Reviewer proposed the sentinel UUID approach as the architectural clean-up.

### Current audit paths

| Path | Source | Target | userId |
|------|--------|--------|--------|
| 1 | `logAuditAsync` (UUID userId) | outbox → worker → audit_logs | UUID FK to users |
| 2 | `logAuditAsync` (null userId) | **direct write** to audit_logs | NULL |
| 3 | worker `writeDirectAuditLog` | direct write to audit_logs | NULL |

### Why path 3 cannot be removed

The outbox worker emits its own meta-events (`AUDIT_OUTBOX_REAPED`, `AUDIT_OUTBOX_DEAD_LETTER`, `AUDIT_OUTBOX_RETENTION_PURGED`, `AUDIT_DELIVERY_FAILED`, `AUDIT_DELIVERY_DEAD_LETTER`) to record outbox processing failures. Routing these through the outbox itself would be self-referential (what records the failure of the meta-event write?). Path 3 stays.

### Why path 2 is the right target

- Anonymous share-access events are **application-emitted**, not worker-emitted. By architectural principle they belong on path 1.
- `SHARE_ACCESS_VERIFY_FAILED` is a brute-force indicator that **should** fan out to SIEM for tenants with external audit forwarding.
- The audit chain (tamper evidence) should include anonymous events for completeness.
- Retry/dead-letter machinery on path 1 is more robust than the direct-write path's try/catch-then-deadLetter.

## Requirements

### Functional

| # | Requirement |
|---|---|
| MF1 | Add `ActorType.ANONYMOUS` enum value to Prisma schema. **All downstream consumers** updated: (a) `src/lib/constants/audit.ts` `ACTOR_TYPE` object; (b) `src/lib/audit-query.ts` `VALID_ACTOR_TYPES` array; (c) `src/components/audit/audit-actor-type-badge.tsx` switch (also fix existing SYSTEM fallthrough bug); (d) `messages/en/AuditLog.json` + `messages/ja/AuditLog.json` i18n keys `actorTypeAnonymous` + `actorTypeSystem` (currently missing); (e) audit log filter UI components; (f) `audit-bypass-coverage.test.ts` exhaustiveness assertion; (g) SIEM payload formatter in `audit-logger.ts` (no code change; verify it handles any actorType string). |
| MF2 | Define two sentinel UUID constants in `src/lib/constants/app.ts`: `ANONYMOUS_ACTOR_ID` and `SYSTEM_ACTOR_ID`. Must be distinct from each other and from `NIL_UUID`. |
| MF3 | DB migration: (a) drop FK `audit_logs.userId → users.id`, (b) drop CHECK constraint `audit_logs_system_actor_user_id_check`, (c) restore `audit_logs.userId` to `NOT NULL`. Data migration: rewrite existing `userId IS NULL AND actor_type = 'SYSTEM'` rows to use `SYSTEM_ACTOR_ID`. |
| MF4 | `AuditLogParams.userId: string \| null → string`. Non-null becomes the invariant. |
| MF5 | `logAuditAsync`: delete the null-userId direct-write branch entirely. All events now flow through `enqueueAudit` → worker → audit_logs. |
| MF6 | `buildOutboxPayload`: remove the `params.userId === null` coercion logic (no longer applicable). |
| MF7 | Worker (`audit-outbox-worker.ts:959`): the "SYSTEM + null userId rejected" guard is **kept** — but the entry state is now impossible from `logAuditAsync` (null is disallowed at the type level). The guard remains as a defense-in-depth check. |
| MF8 | `writeDirectAuditLog` (worker internal): update to write `user_id = SYSTEM_ACTOR_ID` instead of `NULL`. Meta-events get a real sentinel UUID in the userId column, simplifying downstream queries. |
| MF9 | Application callers migrated to sentinel UUID. **Complete list (7 sites)**: (a) `share-links/verify-access` (2 calls) → `ANONYMOUS_ACTOR_ID` + `ANONYMOUS`; (b) `mcp/token/route.ts:138` → `result.userId ?? SYSTEM_ACTOR_ID` + `actorType: SYSTEM`; (c) `mcp/register/route.ts:175` → `SYSTEM_ACTOR_ID` + `SYSTEM` + explicit tenantId; (d) `directory-sync/engine.ts:205` → `actorUserId ?? SYSTEM_ACTOR_ID` + `SYSTEM`; (e) `access-restriction.ts:159` → `userId ?? ANONYMOUS_ACTOR_ID` + `ANONYMOUS` (unauthenticated access denial is anonymous); (f) `team-policy.ts:204` → same as (e); (g) `webhook-dispatcher.ts:235, 306` (2 calls) → `SYSTEM_ACTOR_ID` + `SYSTEM` (webhook delivery failure is a system event). |
| MF10 | `resolveTenantId`: remove the null-guard (`params.userId` null check) since userId is now `string`. **Keep** the `UUID_RE.test` guard as defense-in-depth — it protects against future regressions that pass non-UUID strings. Document in JSDoc that sentinel UUIDs do not exist in `users` table, so callers MUST supply `tenantId` explicitly when using a sentinel (otherwise `user.findUnique` returns null → dead-letter `tenant_not_found`). |
| MF11 | **SIEM / webhook fan-out enablement**: (a) Change `SHARE_ACCESS_VERIFY_*` scope from PERSONAL to TENANT (tenant admins are the actual subscribers of anonymous access events). (b) Add a new `AUDIT_ACTION_GROUP.SHARE` entry to `TENANT_WEBHOOK_EVENT_GROUPS` containing `SHARE_ACCESS_VERIFY_FAILED`, `SHARE_ACCESS_VERIFY_SUCCESS`, `SHARE_CREATE`, `SHARE_REVOKE`, `SHARE_ACCESSED`. (c) Document: IP is included in webhook/SIEM payload; tenants configuring external forwarding must have DPA coverage. Without (a) and (b), `dispatchWebhookForRow` is a no-op for these events and the plan's core security value (brute-force detection via SIEM) is unachieved. |
| MF12 | Chain inclusion: ANONYMOUS actor events **participate in the audit chain** (tenant-scoped). This is the cleanest decision — tamper evidence covers all events uniformly. |
| MF13 | Audit log UI / export / SIEM payload display: sentinel UUIDs resolved to human-readable labels (`Anonymous`, `System`) via a central display helper, not left as raw UUIDs. |
| MF14 | Existing queries filtering by `userId IS NOT NULL` (e.g., "my audit logs") must be reviewed and updated: sentinel UUIDs now satisfy `IS NOT NULL` but should NOT appear in human audit log views. Filter by `actorType = 'HUMAN'` or exclude sentinel IDs. |
| MF15 | Audit metadata: the `{ anonymousAccess: true }` metadata flag in share-links becomes redundant with `actorType = ANONYMOUS`. Remove the flag. **Verification step**: run `grep -rn 'anonymousAccess' src/` after removal and confirm zero residual references. |

### Non-functional

| # | Requirement |
|---|---|
| MN1 | Migration must be forward-only and idempotent within a transaction. Data backfill for existing `userId IS NULL` audit rows executes in the same migration. |
| MN2 | No downtime: the application tolerates both pre- and post-migration state during rollout (i.e., worker + app can handle rows with and without sentinel) for the duration of a deployment window. |
| MN3 | All existing audit queries (personal, team, tenant, breakglass, audit-chain-verify, audit-outbox-metrics) continue to return correct results after the migration. |
| MN4 | Unit tests + integration tests + E2E pass. Manual E2E script (`scripts/manual-tests/share-access-audit.ts`) updated to verify the new flow. |
| MN5 | No regression in audit log write latency. Note: routing ANONYMOUS through outbox adds one transactional INSERT + async worker fan-out; the direct-write path was synchronous. Acceptable because the slowdown is ≤5ms per request and share-access verification is not a hot path. |

## Technical approach

### 1. Prisma schema changes

```prisma
enum ActorType {
  HUMAN
  SERVICE_ACCOUNT
  MCP_AGENT
  SYSTEM
  ANONYMOUS  // NEW: unauthenticated actor (share-access, etc.)
}

model AuditLog {
  // ...
  userId   String   @map("user_id") @db.Uuid   // was: String? (now NOT NULL)
  actorType ActorType @default(HUMAN) @map("actor_type")
  // No more `user User? @relation(...)` — FK removed
  // ...
}
```

### 2. DB migration

`prisma/migrations/<ts>_audit_path_unification/migration.sql`:

```sql
-- 1. Add ANONYMOUS actor type
-- NOTE: ALTER TYPE ADD VALUE cannot run inside a transaction block in some
-- PostgreSQL versions. Prisma migrate wraps migrations in a transaction.
-- If this fails, split into a separate migration file with "-- Prisma
-- migrate: standalone" header or use `CREATE TYPE ... AS ENUM ... ; ALTER
-- TABLE ... ALTER COLUMN ... TYPE ...` pattern.
ALTER TYPE "ActorType" ADD VALUE 'ANONYMOUS';

-- 2. Pre-migration safety check: verify no orphan rows exist beyond SYSTEM+NULL.
--    If this returns non-zero, the migration aborts (manual cleanup required).
--    Note: this DO-block compares against existing enum values ('SYSTEM'), not the
--    newly-added 'ANONYMOUS' — safe to run in the same transaction as Step 1.
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM audit_logs
  WHERE user_id IS NULL AND actor_type != 'SYSTEM';
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % audit_logs rows have NULL user_id with non-SYSTEM actor_type. Manual cleanup required.', orphan_count;
  END IF;
END $$;

-- 3. Backfill ALL NULL userId rows with SYSTEM_ACTOR_ID
--    (post-check above guarantees all remaining NULL rows are actor_type='SYSTEM')
UPDATE audit_logs
SET user_id = '00000000-0000-4000-8000-000000000001'::uuid
WHERE user_id IS NULL;

-- 4. Drop CHECK constraint that allowed NULL userId for SYSTEM
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_system_actor_user_id_check;

-- 5. Drop FK to users (decouples audit from user lifecycle)
--    NOTE: audit_logs_outbox_id_actor_type_check constraint is KEPT — it continues
--    to limit direct writes (outbox_id IS NULL) to SYSTEM actor only. ANONYMOUS
--    events go through outbox (outbox_id IS NOT NULL), satisfying this constraint.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_user_id_fkey;

-- 6. Restore NOT NULL on user_id (sentinel UUIDs fill the previously-null slot)
ALTER TABLE audit_logs ALTER COLUMN user_id SET NOT NULL;
```

Sentinel UUID rationale: deliberately-crafted UUIDs using the **UUIDv4 structural format** (version nibble = 4, variant bits = 10xx) so they satisfy PostgreSQL's `UUID` type and any `UUID_RE.test()` regex. They are **NOT** RFC 4122 "randomly generated" UUIDv4 (random field is zeroed for predictability); a proper UUIDv4 generator will never output these. This is intentional — the sentinels are meant to be visually distinctive in logs and predictable in code.

- `ANONYMOUS_ACTOR_ID = '00000000-0000-4000-8000-000000000000'`
- `SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001'`

Collision risk with a real `uuid(4)` user: 2^-122 (negligible). An invariant test (`sentinel-collision.test.ts`) verifies `SENTINEL_ACTOR_IDS` contains both sentinels and no overlap with `NIL_UUID`.

### 3. Constants

`src/lib/constants/app.ts`:

```typescript
/**
 * Sentinel UUIDs for audit_logs.userId when no real user is associated.
 * Pair with actorType: ANONYMOUS or SYSTEM respectively.
 * NOT users.id values — there is no FK constraint on audit_logs.userId
 * after the audit-path-unification migration.
 */
export const ANONYMOUS_ACTOR_ID = '00000000-0000-4000-8000-000000000000' as const;
export const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001' as const;

/** Set of all sentinel actor IDs, for filter exclusion in human audit log views. */
export const SENTINEL_ACTOR_IDS: ReadonlySet<string> = new Set([
  ANONYMOUS_ACTOR_ID,
  SYSTEM_ACTOR_ID,
]);
```

### 4. `logAuditAsync` simplification

```typescript
export async function logAuditAsync(params: AuditLogParams): Promise<void> {
  const payload = buildOutboxPayload(params);

  // Structured JSON emit (unchanged — fires regardless of outbox success)
  try { auditLogger.info({ audit: { ... } }, `audit.${payload.action}`); } catch {}

  // Outbox enqueue — ALL events, uniformly. Never throws.
  try {
    const tenantId = await resolveTenantId(params);
    if (!tenantId) {
      deadLetterLogger.warn(deadLetterEntry(params, "tenant_not_found"), "audit.dead_letter");
      return;
    }
    await enqueueAudit(tenantId, payload);
  } catch (err) {
    deadLetterLogger.warn(deadLetterEntry(params, "logAuditAsync_failed", String(err)), "audit.dead_letter");
  }
}
```

The null-userId branch is gone. `buildOutboxPayload` no longer coerces actorType; it's the caller's responsibility to pass `actorType: ANONYMOUS` when using `ANONYMOUS_ACTOR_ID`.

### 5. `resolveTenantId` simplification

```typescript
async function resolveTenantId(params: AuditLogParams): Promise<string | null> {
  if (params.tenantId) return params.tenantId;
  return withBypassRls(prisma, async () => {
    if (params.teamId) {
      const team = await prisma.team.findUnique({ where: { id: params.teamId }, select: { tenantId: true } });
      return team?.tenantId ?? null;
    }
    // Sentinel UUIDs don't exist in users table; user.findUnique returns null → caller must supply tenantId
    const user = await prisma.user.findUnique({ where: { id: params.userId }, select: { tenantId: true } });
    return user?.tenantId ?? null;
  }, BYPASS_PURPOSE.AUDIT_WRITE);
}
```

### 6. Caller migration

**share-links/verify-access** (the main target):

```typescript
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit";

await logAuditAsync({
  scope: AUDIT_SCOPE.PERSONAL,
  action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
  userId: ANONYMOUS_ACTOR_ID,
  actorType: ACTOR_TYPE.ANONYMOUS,
  tenantId: share.tenantId,
  targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
  targetId: share.id,
  metadata: { ip },  // anonymousAccess flag removed — actorType conveys this
  ...reqMeta,
});
```

**Other 4 callers** (`mcp/token`, `directory-sync/engine`, `access-restriction`, `team-policy`):

Each reviewed individually (Implementation Step 7):
- If the caller represents **unauthenticated access** → `ANONYMOUS_ACTOR_ID + ANONYMOUS`
- If the caller represents **automated/system action** → `SYSTEM_ACTOR_ID + SYSTEM`
- If the caller can provide a real userId in a different code path → preserve that, use sentinel only as fallback

### 7. Worker update

`src/workers/audit-outbox-worker.ts`:

- **Keep** the null userId rejection at L959 as defense-in-depth (type system now prevents null entry, but guard stays to catch future regressions).
- `writeDirectAuditLog` updated: replace `NULL` with `SYSTEM_ACTOR_ID` in the INSERT.

### 8. UI / display helpers

Introduce a central helper in `src/lib/audit-display.ts`:

```typescript
export function resolveActorDisplay(userId: string, actorType: ActorType): string {
  if (userId === ANONYMOUS_ACTOR_ID) return "Anonymous";
  if (userId === SYSTEM_ACTOR_ID) return "System";
  // ... real user lookup (existing logic)
}
```

Used by:
- Audit log UI (personal/team/tenant views)
- Audit export (CSV/JSONL download)
- SIEM payload formatter (audit-logger.ts)

### 9. Query exclusions

Existing queries using `WHERE userId = <current user>` or similar user-scoped filters continue to work (sentinels are never equal to a real user's ID). New rule: human audit log views SHOULD filter out sentinels to avoid noise:

```typescript
// Before (returned all audit rows for this user)
const logs = await prisma.auditLog.findMany({ where: { userId: session.user.id } });

// No change needed — session.user.id never matches a sentinel.
```

The concern is opposite: tenant-admin views that show "all audit events" will now include ANONYMOUS/SYSTEM rows. That's **desired** (SIEM fan-out + chain completeness require these rows to be visible). No filter change needed — just update the UI label helper (MF13).

### 10. i18n / UI labels

`messages/en/AuditLog.json`, `messages/ja/AuditLog.json`:
- Add `actorType.ANONYMOUS` label (`Anonymous` / `匿名`)
- Existing `actorType.SYSTEM` label unchanged

### 11. Webhook event groups

`src/lib/constants/audit.ts`:
- `ANONYMOUS` actor events use the same event groupings as their actions already define
- No change to `WEBHOOK_DISPATCH_SUPPRESS` or `OUTBOX_BYPASS_AUDIT_ACTIONS`
- Verify `TENANT_WEBHOOK_EVENT_GROUPS` and `TEAM_WEBHOOK_EVENT_GROUPS` include `SHARE_ACCESS_VERIFY_*` actions where tenant admins would want to subscribe

## Implementation steps

1. **Schema + migration**: Add `ActorType.ANONYMOUS`, draft migration SQL (with DO block pre-check for non-SYSTEM NULL rows, see §2), apply locally with `docker compose up -d db` verified, confirm CHECK/FK state matches expectations. Verify `ALTER TYPE ADD VALUE` works inside Prisma migrate's transaction (PG12+) — if not, split into standalone migration.
2. **Constants**: Add `ANONYMOUS_ACTOR_ID`, `SYSTEM_ACTOR_ID`, `SENTINEL_ACTOR_IDS` to `src/lib/constants/app.ts`. Add invariant unit test verifying the two sentinels are distinct from each other and from `NIL_UUID`.
3. **Type changes**: `AuditLogParams.userId: string` (remove `| null`). `buildOutboxPayload` simplification (remove the `params.userId === null` coercion).
4. **`logAuditAsync` refactor**: Delete the null-userId direct-write branch. `resolveTenantId`: remove null-guard but **keep** UUID_RE guard (defense-in-depth).
5. **Caller migration — share-links/verify-access**: 2 calls → `ANONYMOUS_ACTOR_ID + ANONYMOUS + scope=TENANT` (scope change per MF11). Remove `metadata.anonymousAccess` flag. Verify no consumers: `grep -rn 'anonymousAccess' src/` returns zero.
6. **Caller migration — 6 other sites**:
   - `mcp/token/route.ts:138` → `result.userId ?? SYSTEM_ACTOR_ID` + `actorType: SYSTEM`
   - `mcp/register/route.ts:175` → `SYSTEM_ACTOR_ID` + `SYSTEM` + explicit `tenantId`
   - `directory-sync/engine.ts:205` → `actorUserId ?? SYSTEM_ACTOR_ID` + `SYSTEM`
   - `access-restriction.ts:159` → `userId ?? ANONYMOUS_ACTOR_ID` + `ANONYMOUS` (unauth access denial)
   - `team-policy.ts:204` → same pattern as access-restriction
   - `webhook-dispatcher.ts:235, 306` (2 calls) → `SYSTEM_ACTOR_ID` + `SYSTEM` (replace current `NIL_UUID`). Pass `tenantId: webhook.tenantId` (or equivalent) explicitly — sentinel UUIDs are not in `users` table, so `resolveTenantId` cannot derive tenantId from userId lookup.
7. **Worker update**: `writeDirectAuditLog` → use `SYSTEM_ACTOR_ID` instead of NULL in INSERT. L959 null-userId guard **kept** (defense-in-depth).
8. **UI display helper**: `resolveActorDisplay` in `src/lib/audit-display.ts`. Wire into: audit log UI views (personal/team/tenant), audit export (CSV/JSONL), `audit-actor-type-badge.tsx` (also fix pre-existing SYSTEM fallthrough bug). Add ANONYMOUS case + verify SYSTEM case.
9. **i18n labels**: Add `actorTypeAnonymous` and `actorTypeSystem` keys in `messages/en/AuditLog.json` and `messages/ja/AuditLog.json` (SYSTEM key currently missing in AuditLog.json — only in MachineIdentity.json).
10. **Scope + webhook event group**:
    - Change `SHARE_ACCESS_VERIFY_FAILED` and `SHARE_ACCESS_VERIFY_SUCCESS` scope to TENANT in caller (MF11.a)
    - Add `AUDIT_ACTION_GROUP.SHARE` to `TENANT_WEBHOOK_EVENT_GROUPS` in `src/lib/constants/audit.ts` (MF11.b)
11. **VALID_ACTOR_TYPES update**: `src/lib/audit-query.ts:11` — add `"ANONYMOUS"`.
12. **Test updates** (comprehensive):
    - `audit-fifo-flusher.test.ts` — 1:1 replacement of null-userId tests:
      - L82 "bypasses outbox and writes directly for null userId" → "enqueues ANONYMOUS actor via outbox"
      - L109 "forces actorType to SYSTEM when userId is null" → "accepts explicit actorType for sentinel userId"
      - L133 "dead-letters null userId when tenantId is absent" → "dead-letters sentinel UUID when tenantId is absent (user lookup returns null)"
      - L149 "catches direct write failure" → DELETE (direct write path gone; outbox path covered elsewhere)
    - `audit-bypass-coverage.test.ts` — new exhaustiveness test: `Prisma.$Enums.ActorType` all values have i18n keys + VALID_ACTOR_TYPES entries + `SENTINEL_ACTOR_IDS` invariants
    - `audit-outbox-userId-system.integration.test.ts` — rename/rewrite:
      - "allows SYSTEM actor with user_id = NULL" → "allows SYSTEM actor with user_id = SYSTEM_ACTOR_ID"
      - "rejects HUMAN actor with user_id = NULL" → "rejects any actor with user_id = NULL (NOT NULL constraint)"
      - Remove `audit_logs_system_actor_user_id_check` from regex at L96
    - `verify-access/route.test.ts` L230, L254 — update assertions to expect `userId: ANONYMOUS_ACTOR_ID, actorType: "ANONYMOUS"`, remove `metadata.anonymousAccess` check
    - `audit.mocked.test.ts` L379 "mcp_token auth with userId null" — update to reflect `mcp/token/route.ts` new fallback
    - New `src/__tests__/db-integration/audit-sentinel.integration.test.ts`:
      - Verify migration backfill: seed SYSTEM+NULL rows, apply migration, assert rows now have `user_id = SYSTEM_ACTOR_ID`
      - Verify FK drop: INSERT with sentinel UUID that doesn't exist in users succeeds
      - Verify `audit_logs_outbox_id_actor_type_check` still enforced: INSERT with outbox_id=NULL + actor_type=HUMAN fails
      - Verify ANONYMOUS row participates in audit chain (chain_seq increments)
      - Verify RLS: ANONYMOUS row for tenant A not visible to tenant B (existing policy)
      - Verify worker guard unreachable: instrument worker log, submit 100 ANONYMOUS events, assert `worker.system_actor_null_userid_skipped` never appears
13. **Manual test script** (`scripts/manual-tests/share-access-audit.ts`):
    - Reverse assertion: outbox row MUST exist (was: must NOT exist)
    - Assert `user_id = ANONYMOUS_ACTOR_ID` (was: NULL)
    - Assert `actor_type = 'ANONYMOUS'` (was: 'SYSTEM')
    - Assert `outbox_id IS NOT NULL` (was: NULL)
    - Assert `outbox.status = 'SENT'` (worker processed it)
    - Assert `metadata.anonymousAccess` key does NOT exist (removed per MF15)
    - Add SIEM fan-out verification: if tenant has a configured `audit_delivery_target`, assert `audit_deliveries` row created for this outbox entry
14. **Audit UI / export**: verify audit log views correctly resolve sentinel UUIDs via `resolveActorDisplay`. Use Playwright E2E for tenant audit log page.
15. **pre-pr + full test + build**.

## Testing strategy

| Test | Type | What it verifies |
|------|------|-----------------|
| `audit-fifo-flusher.test.ts` | Unit (mocked) | ANONYMOUS + sentinel UUID flows through enqueueAudit; direct write path removed (4 tests renamed/replaced 1:1, not deleted) |
| `audit-bypass-coverage.test.ts` | Unit | `Prisma.$Enums.ActorType` exhaustiveness: all 5 values (HUMAN/SA/MCP/SYSTEM/ANONYMOUS) have i18n key + `VALID_ACTOR_TYPES` entry; `SHARE_ACCESS_VERIFY_*` in `TENANT_WEBHOOK_EVENT_GROUPS.SHARE`; sentinel collision invariants |
| `sentinel-collision.test.ts` (new) | Unit | `ANONYMOUS_ACTOR_ID !== SYSTEM_ACTOR_ID !== NIL_UUID`; `SENTINEL_ACTOR_IDS` membership |
| `share-links/verify-access/route.test.ts` | Unit (mocked) | Asserts `userId: ANONYMOUS_ACTOR_ID`, `actorType: ANONYMOUS`, `scope: TENANT`, `enqueueAudit` called (direct-write mock NOT called), `metadata.anonymousAccess` absent |
| Caller tests (mcp/token, mcp/register, directory-sync, access-restriction, team-policy, webhook-dispatcher) | Unit (mocked) | Each caller uses correct sentinel + actorType. **webhook-dispatcher**: if `src/lib/webhook-dispatcher.test.ts` (or equivalent) exists, update assertions; otherwise add new mini-test alongside this PR verifying the 2 logAuditAsync calls pass sentinel + actorType + tenantId. |
| `audit-outbox-userId-system.integration.test.ts` | Integration (real DB) | Rewritten: SYSTEM_ACTOR_ID accepted; NULL user_id rejected (NOT NULL); regex updated (no `audit_logs_system_actor_user_id_check`) |
| `db-integration/audit-sentinel.integration.test.ts` (new) | Integration (real DB) | 6 scenarios: (1) backfill correctness — seed SYSTEM+NULL rows, run migration, assert SYSTEM_ACTOR_ID; (2) FK drop — sentinel not in users succeeds; (3) `audit_logs_outbox_id_actor_type_check` still enforced; (4) ANONYMOUS in audit chain — chain_seq increments; (5) RLS — cross-tenant isolation; (6) Worker guard unreachable — `worker.system_actor_null_userid_skipped` log never emitted for ANONYMOUS events |
| Tenant audit log UI (Playwright) | E2E | Sentinel UUID rendered as "Anonymous" / "System" via `resolveActorDisplay`; not raw UUID |
| `scripts/manual-tests/share-access-audit.ts` | Manual E2E | Updated: `user_id = ANONYMOUS_ACTOR_ID`, `actor_type = 'ANONYMOUS'`, `outbox_id IS NOT NULL`, `outbox.status = 'SENT'`, `metadata.anonymousAccess` absent, `audit_deliveries` row created (if delivery target configured) |

## Considerations & constraints

### Migration safety

- **FK drop is irreversible without data loss**: existing audit rows would lose referential integrity in a rollback. Document this in the migration header; require explicit opt-in via `DATABASE_URL` pointing at dev/staging before production.
- **Backfill UPDATE on potentially large table**: `audit_logs` can grow to millions of rows. The backfill SQL uses a targeted `WHERE` clause (only SYSTEM + NULL rows), which should match a small set in practice (~hundreds at most). If the set is large, split into batches with `LIMIT` + loop.

### Semantic drift risk (reviewer's point 2)

Existing queries filtering `userId IS NOT NULL` to mean "human-initiated event" will now include sentinels. Audit:
- `src/app/api/audit-logs/route.ts`: personal view — uses `userId: session.user.id` (exact match, not IS NOT NULL) → safe.
- `src/app/api/tenant/audit-logs/**`: tenant admin view — shows all actors; sentinels appearing is DESIRED.
- `src/app/api/tenant/breakglass/[id]/logs/route.ts`: personal log access — uses exact userId match → safe.
- `src/app/api/maintenance/audit-chain-verify/route.ts`: chain verification — iterates all rows; must handle sentinels (they participate in chain).

Search: `grep -rn 'userId.*IS NOT NULL\|userId:\s*{\s*not:\s*null' src/` before finalizing caller migration step.

### Future `userId` rename (reviewer's point 1)

The column now holds actor IDs (real user, sentinel). `userId` becomes a misnomer, but renaming the DB column is a separate large migration (touches indexes, FKs in dependent tables, ORM types, ~200 call sites). **Out of scope**. Add `TODO(audit-path-unification): rename audit_logs.userId → audit_logs.actorId in a follow-up.`

### Chain participation for ANONYMOUS

Including ANONYMOUS events in the audit chain (MF12) means tamper evidence covers public share-access events. This is cleaner but increases chain event rate. Verify chain verification code doesn't break on high-rate anonymous events (e.g., share link brute-force). No special handling needed — chain is tenant-scoped and FIFO, regardless of actor.

### Sentinel UUID collision risk

The sentinel UUIDs are deterministic deliberately. If a real user's ID somehow matches a sentinel, audit queries would misattribute. Mitigation: UUIDs in `users.id` are `uuid(4)` (random v4); the probability of a random UUIDv4 collision with our sentinel is 2^-122 (negligible). Document the constraint in the constant's JSDoc.

### Staging dry-run mandatory before production

- **Migration irreversibility**: FK drop + NOT NULL restoration cannot be rolled back without data loss. Run migration against a staging clone of production data before merging. Verify: (a) DO-block pre-check passes (no orphan non-SYSTEM+NULL rows), (b) backfill UPDATE completes within transaction timeout (lock contention on `audit_logs`), (c) application + worker + integration tests pass against migrated DB.
- **Half-migration recovery**: If `ALTER TYPE ADD VALUE` succeeds but `ALTER TABLE NOT NULL` fails, the DB state is: new enum value exists, FK dropped, CHECK dropped, userId still nullable. Recovery: re-run migration (idempotent up to the DO-block; the `ALTER TYPE` will error "already exists" → document acceptable to ignore via `DO $$BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END$$`).
- **Lock contention on large audit_logs**: Current `audit_logs` row count should be measured pre-migration. If >1M rows, consider `CREATE INDEX CONCURRENTLY` for any new indexes and run backfill in batches (`WHERE ... LIMIT 10000` loop outside the migration transaction). Default assumption: <100k rows, single UPDATE is safe.

### GDPR / privacy posture (explicit)

- **IP in audit metadata**: Continues to be stored post-migration. Legal basis per tenant must be documented (GDPR Art. 6(1)(f) legitimate interest for security monitoring, or Art. 6(1)(c) legal obligation if audit retention is mandatory).
- **FK drop implication**: User deletion no longer cascades to `audit_logs`. This **strengthens** audit trail integrity (compliance with SOC 2, ISO 27001 retention) but **complicates** GDPR Art. 17 right-to-be-forgotten.
- **PII redaction follow-up**: A separate PII redaction plan is required. **Commitment**: track as `TODO(audit-path-unification): PII redaction job for IP addresses in audit_logs.metadata after N days configurable per tenant`. Timeline: within 90 days of this PR merge.
- **Webhook IP forwarding**: Tenants configuring external webhook destinations (SIEM, Slack, etc.) receive raw IP in payload. Document in tenant admin UI webhook configuration help text: "Payloads may contain IP addresses; ensure your destination endpoint has appropriate DPA coverage."

### Out of scope

- Renaming `audit_logs.userId` column to `actorId` (separate migration; currently untracked TODO in review log)
- SIEM-specific payload format changes for ANONYMOUS events (existing formatter handles any actorType)
- Per-tenant configuration to opt out of anonymous event forwarding (existing webhook subscription filter is sufficient)
- Removing `writeDirectAuditLog` (path 3 stays — required for self-referential failure recording)
- Retroactively renaming existing SYSTEM events or changing their semantics
- PII redaction implementation (tracked as follow-up; see GDPR section)

## User operation scenarios

### Scenario 1: Anonymous user tries wrong password on shared link

1. User without authentication POSTs to `/api/share-links/verify-access` with wrong password
2. Route calls `logAuditAsync({ userId: ANONYMOUS_ACTOR_ID, actorType: ANONYMOUS, tenantId, action: SHARE_ACCESS_VERIFY_FAILED, ... })`
3. Event enters `audit_outbox`
4. Worker picks up row (scope=TENANT), verifies CHECK `audit_logs_outbox_id_actor_type_check` (outbox_id IS NOT NULL — satisfied via outbox path), INSERTs into `audit_logs`
5. `dispatchWebhookForRow` fires: scope=TENANT → `dispatchTenantWebhook` invoked; tenant admins subscribed to `AUDIT_ACTION_GROUP.SHARE` (new) receive webhook
6. SIEM delivery target (if configured) receives the event
7. Chain entry appended for this tenant

**Change from current**: Previously step 3 went to direct write; steps 5-7 did NOT happen. Tenants relying on SIEM for brute-force detection now get these signals.

### Scenario 2: Worker detects stuck outbox row and reaps

1. Worker reaper finds row in `processing` older than timeout
2. Worker calls `writeDirectAuditLog(SYSTEM_ACTOR_ID, AUDIT_OUTBOX_REAPED, ...)` — direct write (path 3)
3. Row appears in `audit_logs` with `user_id = SYSTEM_ACTOR_ID, actor_type = SYSTEM`

**Change from current**: Previously `user_id` was NULL. Now it's a real sentinel UUID, making downstream queries uniform.

### Scenario 3: Tenant admin views audit log UI

1. Admin navigates to tenant audit log view
2. Query: `SELECT ... FROM audit_logs WHERE tenant_id = X ORDER BY created_at DESC`
3. Rows include ANONYMOUS events (share-access) and SYSTEM events (worker meta)
4. UI calls `resolveActorDisplay(row.userId, row.actorType)`:
   - `ANONYMOUS_ACTOR_ID + ANONYMOUS` → "Anonymous"
   - `SYSTEM_ACTOR_ID + SYSTEM` → "System"
   - real UUID + HUMAN → user name lookup (existing behavior)
5. Admin sees meaningful labels, not raw UUIDs

### Scenario 4: GDPR user deletion

1. User deleted from `users` table
2. Previously: `ON DELETE CASCADE` would nuke their `audit_logs` rows (compliance concern — audit trail deleted)
3. Now: FK dropped, `audit_logs` rows remain (audit trail preserved)
4. Separate PII redaction job (out of scope here) runs periodically to redact PII from `metadata` column while preserving audit structure

## Implementation Checklist

### Files to modify

**Schema / Migration:**
- `prisma/schema.prisma` — enum `ActorType` (+ANONYMOUS), `model AuditLog.userId` (String → non-null, remove FK relation), remove `@@index` rebuild if needed
- `prisma/migrations/<ts>_audit_path_unification/migration.sql` — new migration per §2

**Constants / Core lib:**
- `src/lib/constants/app.ts` — add `ANONYMOUS_ACTOR_ID`, `SYSTEM_ACTOR_ID`, `SENTINEL_ACTOR_IDS`
- `src/lib/constants/audit.ts` — add `ACTOR_TYPE.ANONYMOUS`; add `TENANT_WEBHOOK_EVENT_GROUPS[SHARE]`
- `src/lib/audit-query.ts:11` — add `"ANONYMOUS"` to `VALID_ACTOR_TYPES`
- `src/lib/audit.ts` — `AuditLogParams.userId: string` (non-null); `buildOutboxPayload` remove null-coercion; `resolveTenantId` remove null-guard (keep UUID_RE); `logAuditAsync` delete null direct-write branch; update JSDoc header comment at L5-9
- `src/lib/audit-outbox.ts:9` — `AuditOutboxPayload.userId: string`
- `src/lib/audit-display.ts` (NEW) — `resolveActorDisplay(userId, actorType)`
- `src/workers/audit-outbox-worker.ts` — L40 `userId: string`; L72 coercion; L355 `writeDirectAuditLog` uses `SYSTEM_ACTOR_ID` instead of NULL; L560 remove null fallback; L942, L959 keep null guard as defense-in-depth

**Callers (7 sites):**
- `src/app/api/share-links/verify-access/route.ts:73, 88` — `ANONYMOUS_ACTOR_ID + ANONYMOUS + scope:TENANT`, remove `anonymousAccess` flag
- `src/app/api/mcp/token/route.ts:124, 138` — `result.userId ?? SYSTEM_ACTOR_ID + SYSTEM`
- `src/app/api/mcp/register/route.ts:175` — `SYSTEM_ACTOR_ID + SYSTEM + explicit tenantId`
- `src/lib/directory-sync/engine.ts:205` — `actorUserId ?? SYSTEM_ACTOR_ID + SYSTEM`
- `src/lib/access-restriction.ts:159` — `userId ?? ANONYMOUS_ACTOR_ID + ANONYMOUS`
- `src/lib/team-policy.ts:204` — same pattern
- `src/lib/webhook-dispatcher.ts:235, 306` — `SYSTEM_ACTOR_ID + SYSTEM + explicit tenantId`

**UI / i18n:**
- `src/components/audit/audit-actor-type-badge.tsx` — add ANONYMOUS case + fix SYSTEM fallthrough (use `resolveActorDisplay`)
- `messages/en/AuditLog.json`, `messages/ja/AuditLog.json` — add `actorTypeSystem`, `actorTypeAnonymous`

**Tests:**
- `src/__tests__/audit-fifo-flusher.test.ts` — 1:1 replace 4 null-userId tests per Step 12
- `src/__tests__/audit-bypass-coverage.test.ts` — add ActorType exhaustiveness assertions
- `src/__tests__/sentinel-collision.test.ts` (NEW) — invariant tests for SENTINEL_ACTOR_IDS
- `src/__tests__/db-integration/audit-outbox-userId-system.integration.test.ts` — rewrite per Step 12
- `src/__tests__/db-integration/audit-sentinel.integration.test.ts` (NEW) — 6 scenarios per Step 12
- `src/app/api/share-links/verify-access/route.test.ts` — update assertions L230, L254
- `src/__tests__/audit.mocked.test.ts` L379 — update mcp_token assertions
- `scripts/manual-tests/share-access-audit.ts` — reverse assertions per Step 13

### Shared utility inventory

Reused (DO NOT reimplement):
- `NIL_UUID, UUID_RE` ([src/lib/constants/app.ts:17-19]) — base UUID constants
- `ACTOR_TYPE` object ([src/lib/constants/audit.ts:3]) — add ANONYMOUS alongside
- `AUDIT_ACTION_GROUP, AUDIT_ACTION_GROUPS_TENANT` ([src/lib/constants/audit.ts]) — existing groups for webhook fan-out
- `withBypassRls, BYPASS_PURPOSE` ([src/lib/tenant-rls.ts]) — existing RLS bypass wrapper
- `auditLogger, deadLetterLogger` ([src/lib/audit-logger.ts]) — structured JSON emitters
- `enqueueAudit, enqueueAuditInTx` ([src/lib/audit-outbox.ts]) — outbox entry points
- `extractRequestMeta, sanitizeMetadata, truncateMetadata` ([src/lib/audit.ts]) — existing helpers
- `resolveActorType` ([src/lib/audit.ts:55]) — AuthResult → ActorType (unchanged)

New (create once, reuse):
- `ANONYMOUS_ACTOR_ID, SYSTEM_ACTOR_ID, SENTINEL_ACTOR_IDS` in `src/lib/constants/app.ts`
- `resolveActorDisplay(userId, actorType)` in `src/lib/audit-display.ts` (single central helper, used by UI/export/SIEM)

### Cross-cutting patterns to follow

- i18n keys: bilingual update (en + ja) mandatory for every new label
- Outbox payload enqueue: `enqueueAudit(tenantId, payload)` is the sole path; no direct `prisma.auditLog.create` in application code
- Sentinel UUIDs: used ONLY with matching `actorType` (`ANONYMOUS_ACTOR_ID` ↔ `ANONYMOUS`, `SYSTEM_ACTOR_ID` ↔ `SYSTEM`). Mismatch is a caller bug
- Explicit `tenantId` MUST be passed when userId is a sentinel (sentinels don't exist in `users`, so `resolveTenantId` lookup returns null → dead-letter)

**Implication**: A separate follow-up may be needed to run a PII-redaction job. Track as TODO.
