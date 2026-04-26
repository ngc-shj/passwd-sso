# Plan: audit-log-purge-action-and-dryrun-audit

Branch: `feat/audit-log-purge-action-and-dryrun-audit`
Plan file: `docs/archive/review/audit-log-purge-action-and-dryrun-audit-plan.md`

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + PostgreSQL 16, multi-tenant password manager)
- **Test infrastructure**: unit + integration (vitest, real-DB integration tests)
- Audit logs are written via `audit_outbox` (transactional) → drained to `audit_logs` by a separate worker process.
- `AUDIT_ACTION` is a Prisma-generated enum (DB-backed); adding a value requires a schema migration.

## Objective

Resolve two carry-over findings from the PR #398 review log
([csrf-admin-token-cache-review.md](csrf-admin-token-cache-review.md)):

- **F1/S3** — `purge-audit-logs/route.ts:94` reuses `AUDIT_ACTION.HISTORY_PURGE`
  for an action that purges audit logs (not entry history). The two operations
  collapse under the same SIEM/UI label, harming auditability and forensic
  triage. Introduce a dedicated `AUDIT_LOG_PURGE` action.
- **F3** — `purge-history` and `purge-audit-logs` `dryRun` branches return
  early without emitting an audit log, so admin probes are unobservable. SOC 2
  / ISO 27001 typically require all admin actions to be auditable, including
  dry runs. Emit an audit log with `metadata.dryRun: true` and the `matched`
  count before the early return.

## Requirements

### Functional

1. New `AUDIT_LOG_PURGE` enum value present in:
   - Prisma schema (DB enum)
   - `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_TENANT.ADMIN`
   - i18n labels (en/ja)
2. `purge-audit-logs/route.ts` emits `AUDIT_LOG_PURGE` (not `HISTORY_PURGE`)
   for both real and dry-run paths.
3. `purge-history/route.ts` continues to emit `HISTORY_PURGE` for both real
   and dry-run paths.
4. `dryRun: true` audit metadata MUST include `dryRun: true` and `matched`
   (the count of rows that would be deleted).
5. Real-mode (`dryRun: false`) audit metadata is unchanged for
   `purge-history`; for `purge-audit-logs` only the action label changes.

### Non-functional

- Backward compat for SIEM consumers querying historical
  `action=HISTORY_PURGE` rows: existing rows MUST NOT be rewritten; the
  schema change is additive only.
- Migration is additive (`ALTER TYPE ... ADD VALUE`) — no destructive DDL.
- The new constant must be placed alphabetically/contextually adjacent to
  `HISTORY_PURGE` in source so future readers find both side-by-side.
- A SIEM-query orientation comment is added near the `AUDIT_LOG_PURGE`
  definition explaining the historical/forward semantics gap (rows before
  this PR conflate history and audit-log purges under `HISTORY_PURGE`).

### Out of scope

- Backfilling old `HISTORY_PURGE` rows in `audit_logs` to retroactively
  distinguish them — historical SIEM queries must remain valid; the new
  semantic split applies forward only.
- Adding `AUDIT_LOG_PURGE` to `PERSONAL.HISTORY` / `TEAM.HISTORY`
  (intentional; audit-log purge is a tenant-system-wide admin operation,
  not a personal/team history concern — per user's explicit instruction).
- F1 from PR #398 review log (`src/proxy.ts` row count reduction).
- S2 from review log (CSP `form-action` localhost) — separate plan.

## Technical approach

### Schema migration (additive)

`prisma/schema.prisma`:
```prisma
enum AuditAction {
  // ... existing values ...
  HISTORY_PURGE
  AUDIT_LOG_PURGE   // new — placed adjacent to HISTORY_PURGE
  MASTER_KEY_ROTATION
  // ...
}
```

Migration generated via `npm run db:migrate` (Prisma) — must produce a
single `ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_LOG_PURGE'` statement,
not a table rebuild.

Note: PostgreSQL ENUM additions cannot run inside a transaction with the
default Prisma migration wrapper. Prisma 7 auto-detects this and emits
the migration outside a transaction. Verify the generated SQL has the
expected `ALTER TYPE` form (no `BEGIN`/`COMMIT` wrapping the enum add).

### Constants module

`src/lib/constants/audit/audit.ts`:
- `AUDIT_ACTION`: insert `AUDIT_LOG_PURGE: "AUDIT_LOG_PURGE"` after
  `HISTORY_PURGE`. The trailing
  `as const satisfies Record<AuditAction, AuditAction>` enforces
  exhaustiveness against the Prisma enum, so a missing entry is a TS error.
- `AUDIT_ACTION_VALUES`: insert `AUDIT_ACTION.AUDIT_LOG_PURGE` after
  `AUDIT_ACTION.HISTORY_PURGE`. **Note (F1)**: this array has NO
  compile-time guard against the `AuditAction` Prisma enum — a missing
  entry only fails at vitest run time (`audit.test.ts:212` exhaustiveness
  + `audit-i18n-coverage.test.ts` + `i18n/audit-log-keys.test.ts`).
  Both `npx next build` AND `npx vitest run` must pass before declaring
  step 2 complete.
- `AUDIT_ACTION_GROUPS_TENANT.ADMIN`: insert `AUDIT_ACTION.AUDIT_LOG_PURGE`
  after `AUDIT_ACTION.HISTORY_PURGE` (line ~521). **Note (F2)**:
  `TENANT_WEBHOOK_EVENT_GROUPS.ADMIN` (line 608) references
  `AUDIT_ACTION_GROUPS_TENANT.ADMIN` directly (not a copy), so adding
  here also propagates to webhook subscription automatically — NO
  separate webhook-group update is required.
- Do NOT add to `AUDIT_ACTION_GROUPS_PERSONAL.HISTORY` or
  `AUDIT_ACTION_GROUPS_TEAM.HISTORY` — purge is tenant-admin only.
- SIEM-orientation comment placed at the `AUDIT_ACTION` definition site
  (near line 65) explaining: "Rows logged before $DATE used `HISTORY_PURGE`
  for both entry-history purges AND audit-log purges. Forward queries
  filtering by purge type must include both `HISTORY_PURGE` (legacy +
  current entry-history) and `AUDIT_LOG_PURGE` (current audit-log).
  Pre-merge `purge-audit-logs` rows can also be disambiguated by
  `metadata.targetTable === 'auditLog'`."

### Route changes

`src/app/api/maintenance/purge-audit-logs/route.ts`:
- Line 94: `AUDIT_ACTION.HISTORY_PURGE` → `AUDIT_ACTION.AUDIT_LOG_PURGE`
- Lines 87-89 (dryRun early return): emit
  `logAuditAsync({ action: AUDIT_LOG_PURGE, metadata: { ..., dryRun: true, matched: totalPurged } })`
  BEFORE the early return.
- **Note (F3)**: in the dryRun branch, `totalPurged` (computed at line 84
  via `perTenantCounts.reduce(...)`) actually holds the matched count
  (sum of `auditLog.count(...)` results), not a deletion count — the
  variable name pre-dates this PR. Reuse it for `matched` without
  rename. Document with a one-line inline comment: `// dryRun: totalPurged
  here is the matched count, not deleted`.
- The metadata object retains existing keys (`operatorId`, `purgedCount`
  via `AUDIT_METADATA_KEY`, `retentionDays`, `targetTable: "auditLog"`,
  `systemWide: true`), with `purgedCount: 0` and `matched: <count>` for
  the dry-run path. Real-mode emits `purgedCount: <actual>` without
  `dryRun` and without `matched` (existing behavior).
- **Note (S5)**: rate limiter at line 39 uses fixed key
  (`"rl:admin:purge-audit-logs"`, `max: 1, windowMs: 60_000`) covering
  BOTH dryRun and real calls together. This is intentional security
  posture (prevents probe→exploit racing) — add a one-line code comment
  at the limiter declaration to document this, so future contributors
  do not "fix" it by per-mode keys.

`src/app/api/maintenance/purge-history/route.ts`:
- Lines 61-67 (dryRun early return): emit
  `logAuditAsync({ action: HISTORY_PURGE, metadata: { ..., dryRun: true, matched } })`
  BEFORE the early return. The `matched` value comes from the count query
  result at the same site (`prisma.passwordEntryHistory.count(...)`).
- Real-mode behavior unchanged.
- **Note (S5)**: rate limiter at line 41 uses fixed key
  (`"rl:admin:purge-history"`, `max: 1, windowMs: 60_000`) covering BOTH
  dryRun and real calls together. Same intentional security posture as
  `purge-audit-logs` — add the same one-line documenting comment.

### i18n labels

`messages/en/AuditLog.json` (after `HISTORY_PURGE` line):
```json
"AUDIT_LOG_PURGE": "Purged audit logs",
```

`messages/ja/AuditLog.json` (after `HISTORY_PURGE` line):
```json
"AUDIT_LOG_PURGE": "監査ログの期限削除",
```

## Implementation steps

1. **Generate Prisma migration**
   - Edit `prisma/schema.prisma` AuditAction enum: insert `AUDIT_LOG_PURGE`
     after `HISTORY_PURGE` (alphabetical adjacency of related actions).
   - Run `npm run db:migrate` (writes
     `prisma/migrations/<ts>_add_audit_log_purge_action/migration.sql`).
   - Verify generated SQL is `ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_LOG_PURGE'` only.
   - `git add prisma/migrations/<ts>_add_audit_log_purge_action/`
   - Run `npx prisma generate` to refresh the typed client.

2. **Update constants module** (`src/lib/constants/audit/audit.ts`)
   - Add `AUDIT_LOG_PURGE` to `AUDIT_ACTION` (TS exhaustiveness will
     break the build until the Prisma client is regenerated in step 1).
   - Add to `AUDIT_ACTION_VALUES`.
   - Add to `AUDIT_ACTION_GROUPS_TENANT.ADMIN`.
   - Add the SIEM-orientation comment.

3. **Add i18n labels** (en + ja `AuditLog.json`)

4. **Update `purge-audit-logs/route.ts`**
   - Replace `AUDIT_ACTION.HISTORY_PURGE` with `AUDIT_ACTION.AUDIT_LOG_PURGE` (line 94).
   - Add `logAuditAsync` call before the dryRun early return (line 87-89)
     with `metadata.dryRun: true, metadata.matched: totalPurged`.

5. **Update `purge-history/route.ts`**
   - Add `logAuditAsync` call before the dryRun early return (line 61-67)
     with `metadata.dryRun: true, metadata.matched`. Action remains `HISTORY_PURGE`.

6. **Update tests**

   **Critical sequencing warning (T3)**: Step 2 (constants update) without
   step 3 (i18n keys) leaves `src/__tests__/audit-i18n-coverage.test.ts:21`
   and `src/__tests__/i18n/audit-log-keys.test.ts:19` failing. These two
   files iterate `AUDIT_ACTION_VALUES` / `Object.values(AUDIT_ACTION)` and
   assert every entry has en+ja labels. Steps 2 and 3 MUST be completed
   together before running the full test suite.

   Test edits required:

   - `src/lib/constants/audit/audit.test.ts:25` — add
     `expect(adminActions).toContain(AUDIT_ACTION.AUDIT_LOG_PURGE)` after
     the existing `HISTORY_PURGE` assertion. The `:212` exhaustiveness
     test ("every action belongs to at least one scope group") passes
     automatically once `AUDIT_LOG_PURGE` is in `TENANT.ADMIN`.
   - `src/components/settings/developer/tenant-webhook-card.test.tsx:163-164` —
     add a parallel assertion for `AUDIT_LOG_PURGE` (it's also subscribable
     since it's in `AUDIT_ACTION_GROUPS_TENANT.ADMIN`, which feeds
     `TENANT_WEBHOOK_EVENT_GROUPS.ADMIN`).
   - `src/app/api/maintenance/purge-audit-logs/route.test.ts:299-313` —
     **(T1)** update the FULL `expect(mockLogAudit).toHaveBeenCalledWith(
     expect.objectContaining({ ... action: 'AUDIT_LOG_PURGE' ... }))` block,
     not just the literal at line 302. The existing block is multi-line.
   - `src/app/api/maintenance/purge-audit-logs/route.test.ts:316-328`
     (dryRun test) — **(T4)** invert the assertion to:
     ```ts
     expect(mockLogAudit).toHaveBeenCalledWith(
       expect.objectContaining({
         scope: "TENANT",
         action: "AUDIT_LOG_PURGE",
         metadata: expect.objectContaining({
           dryRun: true,
           matched: <expected_n>,
         }),
       }),
     );
     ```
     Use `expect.objectContaining` at BOTH outer and metadata levels —
     bare `toHaveBeenCalledWith({...})` will fail because `tenantAuditBase`
     populates `userId`, `actorType`, `tenantId`, `ip`, `userAgent`,
     `acceptLanguage` that are not asserted here.
     **(T7)** Rename the test from `"does not log audit on dryRun"` to
     `"emits audit log with dryRun: true metadata on dryRun"`.
   - `src/app/api/maintenance/purge-history/route.test.ts:280-294` —
     **(T2)** real-mode block; line 283 contains `action: "HISTORY_PURGE"`
     inside `expect.objectContaining(...)`. Keep this unchanged.
   - `src/app/api/maintenance/purge-history/route.test.ts:297-308`
     (dryRun test) — **(T4)** invert with same `expect.objectContaining`
     pattern as above; action remains `HISTORY_PURGE`. Rename test name
     **(T7)** the same way.

7. **Verification**
   - Run `npm run db:migrate` against dev DB to confirm migration is
     re-runnable from a clean state (per
     `feedback_run_migration_on_dev_db.md`).
   - Run `npx vitest run` — all tests pass, especially the
     `audit.test.ts` exhaustiveness suite.
   - Run `npx next build` — Prisma client regen + TypeScript exhaustiveness
     checks pass.
   - Run `bash scripts/pre-pr.sh` — 11/11 checks pass.

## Testing strategy

| Layer | Test |
|-------|------|
| Constants exhaustiveness | `audit.test.ts` enforces every `AUDIT_ACTION` value is in at least one scope group; build fails otherwise. |
| Route action label | `purge-audit-logs/route.test.ts` asserts `action: "AUDIT_LOG_PURGE"`; `purge-history/route.test.ts` asserts `action: "HISTORY_PURGE"`. |
| dryRun audit emission | Both route tests' dryRun cases assert `mockLogAudit.toHaveBeenCalledWith({ action, metadata: { dryRun: true, matched: <count> } })` (replaces existing `not.toHaveBeenCalled()`). |
| i18n coverage | The translation key MUST exist in both `messages/en/AuditLog.json` and `messages/ja/AuditLog.json`; downstream UI tests rendering the label catch missing keys. |
| Webhook subscription | `tenant-webhook-card.test.tsx` asserts `AUDIT_LOG_PURGE` appears in the subscribable list (since it's in `AUDIT_ACTION_GROUPS_TENANT.ADMIN`, which feeds `TENANT_WEBHOOK_EVENT_GROUPS`). |
| Migration | Run against dev DB before committing (`feedback_run_migration_on_dev_db.md`). |

## Considerations & constraints

### Backward compatibility for SIEM consumers

- **Forward semantics** (post-merge): `HISTORY_PURGE` = entry-history
  retention purge; `AUDIT_LOG_PURGE` = audit-log retention purge.
- **Historical rows** (pre-merge): all retention-purge rows are tagged
  `HISTORY_PURGE` regardless of which table they purged. SIEM queries
  joining on the action label cannot distinguish historical rows.
- **Mitigation**: SIEM-orientation comment in `audit.ts` documents the
  semantic boundary date for downstream consumers.
- **Out of scope**: backfill of existing rows. The metadata column on
  historical `HISTORY_PURGE` rows from `purge-audit-logs` already contains
  `targetTable: "auditLog"`, so SIEM consumers can disambiguate via metadata
  for rows after that key was added; older rows have only `operatorId` +
  `purgedCount` and are inherently ambiguous.

### Module dependency / circularity

- `purge-audit-logs/route.ts` already imports `AUDIT_ACTION` from
  `@/lib/constants/audit/audit`. No new import paths.
- `audit.ts` does not import from route handlers; no circular risk.
- New i18n key is read by `next-intl` consumers via the runtime locale
  loader, not by build-time imports — no module graph impact.

### Webhook dispatch loop guard

- `AUDIT_LOG_PURGE` is added to `AUDIT_ACTION_GROUPS_TENANT.ADMIN`,
  which is included in `TENANT_WEBHOOK_EVENT_GROUPS.ADMIN`. This means
  the new action is subscribable as a webhook event (intended).
- The webhook dispatcher MUST NOT log a `WEBHOOK_DELIVERY_FAILED` audit
  event that itself triggers another webhook dispatch (R13). The existing
  `webhook-dispatcher` already excludes `WEBHOOK_*` from re-dispatch; no
  new exclusion needed since `AUDIT_LOG_PURGE` is a normal admin event.

### Async dispatch transaction boundary (R9)

- `logAuditAsync` for the dryRun path is invoked OUTSIDE any DB transaction
  (the dryRun branch only does a SELECT count, no transaction). Safe.

### Migration in CI

- Per `feedback_prisma_migrate_drift.md`: if the migration fails in CI
  due to drift, verify no orphan `_prisma_migrations` rows from local dev
  exist. Use `npx prisma migrate status` to confirm.

## User operation scenarios

1. **Admin invokes `/api/maintenance/purge-audit-logs?dryRun=true`**
   Expected: 200 response with `{ purged: 0, matched: <count>, dryRun: true }`.
   Audit log row appears in `audit_logs` (after worker drains the outbox)
   with `action: "AUDIT_LOG_PURGE"`, `metadata.dryRun: true`,
   `metadata.matched: <count>`. SIEM queries filtering by
   `action="AUDIT_LOG_PURGE" AND metadata.dryRun=true` surface admin probes.

2. **Admin invokes `/api/maintenance/purge-audit-logs` (real, no dryRun)**
   Expected: 200 with `{ purged: <count> }`. Audit log:
   `action: "AUDIT_LOG_PURGE"`, `metadata.purgedCount: <count>` (no
   `dryRun` key). Distinguishable from entry-history purge in SIEM.

3. **Admin invokes `/api/maintenance/purge-history?dryRun=true`**
   Expected: 200 with `{ purged: 0, matched: <count>, dryRun: true }`.
   Audit log: `action: "HISTORY_PURGE"`, `metadata.dryRun: true`,
   `metadata.matched: <count>`.

4. **SIEM operator queries "all retention purges in the last 30 days"**
   Pre-merge: filter `action="HISTORY_PURGE"` returns both entry-history
   and audit-log purges (ambiguous).
   Post-merge: filter `action IN ("HISTORY_PURGE", "AUDIT_LOG_PURGE")` for
   any retention purge; filter by individual action for the specific kind.
   The orientation comment in `audit.ts` documents the semantic boundary.

5. **Tenant webhook subscriber configured for the ADMIN group**
   Expected: receives a webhook on `AUDIT_LOG_PURGE` events (the action is
   in `TENANT_WEBHOOK_EVENT_GROUPS.ADMIN` via inclusion in
   `AUDIT_ACTION_GROUPS_TENANT.ADMIN`).

## Implementation Checklist

(Populated after Step 2-1 in Phase 2 — full grep + scan to be performed
before coding starts.)
