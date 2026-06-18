# Plan: retention-trash-purge (SC2)

## Project context
- Service (Next.js + Prisma 7 + PostgreSQL 16, multi-tenant RLS, least-privilege roles) + retention-GC worker (engine + SC5 + SC4 merged).
- Test infra: unit + integration (real-DB) + CI.

## Objective
Auto-purge soft-deleted (trashed) vault entries past a tenant-configured grace period — `password_entries` and `team_password_entries` with `deleted_at` set — which #571 deferred (SC2) because deleting them must also clean up encrypted `Attachment` blobs, and when an external blob backend (S3/Azure/GCS) is configured a raw DB cascade DELETE would orphan the external objects (R6).

## Background facts (verified)
- `password_entries.deleted_at` / `team_password_entries.deleted_at` — soft-delete tombstone (nullable). RLS-enabled, tenant-scoped.
- `Attachment` rows FK `password_entry_id` / `team_password_entry_id` → entry `ON DELETE CASCADE`; the blob lives in `Attachment.encrypted_data` (Bytes) for the **DB** backend, OR externally (S3/Azure/GCS) with `encrypted_data` holding the object ref.
- Existing reusable helpers (`src/lib/blob-store/cleanup.ts`): `collectEntryAttachmentRefs(client, scope)` returns `[]` for the DB backend (cascade handles it) and the external object refs otherwise; `deleteAttachmentBlobs(refs)` removes external objects. `getAttachmentBlobStore()` is env-driven (`BLOB_BACKEND`) and works in the worker process (Prisma-based, no Next.js runtime dependency).
- `Tenant.auditLogRetentionDays` (schema:589) is the per-tenant-retention pattern to mirror.

## Policy decisions (user-confirmed)
- **Grace period: tenant-configurable** — add `Tenant.trashRetentionDays Int?` (NULL = never auto-purge, mirrors auditLogRetentionDays NULL-skip). Cutoff: `deleted_at < now() - trashRetentionDays days`.
- **External blobs: the worker deletes them** — reuse `collectEntryAttachmentRefs` → `deleteAttachmentBlobs` before deleting DB rows.

## Technical approach
Add a registry kind **`PER_TENANT_TRASH`** (per-tenant, with blob side effect). For each entry (one per entry-table: password_entries, team_password_entries), per sweep:
1. Enumerate tenants with `trashRetentionDays IS NOT NULL`.
2. Per tenant: compute cutoff; SELECT trashed entry ids past cutoff (LIMIT batchSize) under bypass_rls.
3. `collectEntryAttachmentRefs(tx, scope)` → external blob refs (empty for DB backend).
4. **Delete external blobs FIRST** (`deleteAttachmentBlobs(refs)`) — outside or before the DB delete so an orphaned external object never outlives the DB row. (Ordering: collect refs in tx → delete DB rows in tx → on commit, delete external blobs. If external-blob delete is best-effort like empty-trash's `Promise.allSettled`, a failed external delete leaves an orphan but the DB row is gone — matches the existing empty-trash contract. **Decision: mirror empty-trash exactly** — collect refs, delete DB rows (cascade attachments), then best-effort external-blob delete after commit. This is the established app behavior; consistency over a stricter guarantee.)
5. `deleteMany` the entry ids (cascade removes Attachment DB rows + DB-backend blobs).

### Registry entry
```
interface PerTenantTrashEntry {
  kind: "PER_TENANT_TRASH";
  table: "password_entries" | "team_password_entries";
  scopeKind: "personal" | "team";
  tenantRetentionColumn: "trashRetentionDays";
}
```

## Contracts

### C1 — schema + migration — locked
- Add `Tenant.trashRetentionDays Int?` (mirror auditLogRetentionDays). Migration: additive nullable column (no backfill needed — NULL = current behavior, no auto-purge). Add a validation min/max constant (mirror AUDIT_LOG_RETENTION_MIN; e.g. min 1, max 3650) if exposed via policy API — **policy API/UI is OUT OF SCOPE for this PR** (the column + worker only; UI wiring is a follow-up). Document that.
- Invariant: additive-only migration (R24 — nullable, no strict constraint).

### C2 — registry kind + entries + validator — locked
- Extend `RetentionEntryKind` with `"PER_TENANT_TRASH"`; add `PerTenantTrashEntry`; add 2 entries. Validator: assertIdentifier on table; no globalDelete field needed (the sweeper sets bypass_rls explicitly like sweepAuditLogs). DMMF cross-check: table + that deleted_at exists.

### C3 — sweepTrashEntry — locked
- `sweepTrashEntry(workerPrisma, entry, batchSize): Promise<number>`:
  - Enumerate tenants with trashRetentionDays NOT NULL (mirror sweepAuditLogs tenant enumeration).
  - Per tenant, in a tx: set bypass_rls FIRST (before any SELECT — both entry tables AND attachments are RLS-enabled); SELECT trashed entries past `now() - retention days` (LIMIT batchSize) — for `team_password_entries` SELECT `(id, team_id)`, for `password_entries` SELECT `id`.
  - **Team multi-team grouping (review F4)**: `collectEntryAttachmentRefs`'s team scope requires a SINGLE `teamId`, but a tenant spans many teams. For `team_password_entries`, GROUP the selected entry ids BY `team_id` and call `collectEntryAttachmentRefs(tx, { kind: "team", teamId, entryIds })` once per team-id group. For `password_entries` call once with `{ kind: "personal", entryIds }`. Accumulate all refs.
  - `deleteMany` entries by id (cascade removes attachments + history + favorites + tag links; SetNull on password_shares).
  - After the tx commits: `deleteAttachmentBlobs(allRefs)` (best-effort `Promise.allSettled`, mirrors empty-trash).
  - Emit a CREDENTIAL-style audit? Optional — a TRASH_RETENTION_PURGED audit action per tenant with the count (mirrors RETENTION_GC_SWEEP heartbeat, under the tenant). **Decision: include a per-tenant TRASH_RETENTION_PURGED audit** so the tenant sees the auto-purge in their log (consistency with SC4's per-tenant forensic record).
  - Return total deleted across tenants.
- Invariant: blob refs collected BEFORE the DB delete (the cascade destroys the Attachment rows; we need their refs first). External blob delete is best-effort post-commit (matches empty-trash).

### C4 — sweepOnce dispatch — locked (corrected per review F1)
- **Reality check**: ALL existing kinds (incl. PER_TENANT_FN/sweepAuditLogs) are dispatched as `workerPrisma.$transaction(tx => sweepX(tx, entry, ...))` — they receive a `tx`, NOT workerPrisma. (The earlier plan claim was wrong.)
- `PER_TENANT_TRASH` is the **first** kind that legitimately needs `workerPrisma` directly (not a tx): the external-blob delete must happen AFTER the DB tx commits, so `sweepTrashEntry` must own its inner transaction(s). The dispatch branch calls `sweepTrashEntry(workerPrisma, entry, batchSize)` directly — NO outer `$transaction` wrapper. State this as a new pattern.

### C5 — audit action — locked
- Add `AUDIT_ACTION.TRASH_RETENTION_PURGED` (const + VALUES + MAINTENANCE group + en/ja + Prisma enum + separate enum migration).

### C6 — DB role grant — locked (corrected per review F3)
- Grant `passwd_retention_gc_worker`: `SELECT, DELETE` on `password_entries`, `team_password_entries`; `SELECT` on `attachments` (for `collectEntryAttachmentRefs`). `SELECT` on `tenants` (already granted).
- **Full cascade reach (R14, must be confirmed intentional)** — deleting a trashed entry cascades to ALL of: `attachments` (Cascade), `password_entry_histories` / `team_password_entry_histories` (Cascade), `team_password_favorites` (Cascade), `_PasswordEntryToTag` / `_TeamPasswordEntryToTeamTag` join tables (Cascade), and SetNull on `password_shares`. **All pure-cascade/SetNull → NO grant needed** (the RI trigger runs internally, doesn't re-check invoking-role privileges; RLS satisfied by bypass_rls — the SC5 lesson). The worker needs DELETE only on the two entry tables and SELECT on attachments. Purging a trashed entry removing its history/favorites/tag-links is the intended semantics. Verify the grant set + cascade against live DB; the integration test proves the cascade works with attachments SELECT-only (no child DELETE grant).

### C7 — tests — locked
- Unit: sweepTrashEntry tenant enumeration + cutoff math; the blob-ref-before-delete ordering.
- Integration (real DB, DB backend): trashed entry past grace → deleted + its attachment (DB blob) gone via cascade; trashed entry within grace → kept; non-trashed (deletedAt NULL) → kept; NULL retention tenant → skipped; role-grant positive+negative.
- External-blob path: unit-test `collectEntryAttachmentRefs`→`deleteAttachmentBlobs` with a mocked blob store — the real S3/Azure/GCS delete is not exercisable in CI (no bucket), blocked-deferred.
  - **T1 (multi-team partition)**: the external-blob unit test MUST exercise a tenant with trashed `team_password_entries` across ≥2 teams, asserting `collectEntryAttachmentRefs` is called once per team-id group with correctly partitioned ids + the right `teamId` in each context (this is where F4's grouping bug would surface — a single-team test would pass with the bug).
  - **T2 (negative grant)**: integration test that the worker role canNOT directly `DELETE FROM attachments` (only via cascade) — mirrors the SC5 positive+negative role pattern.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Tenant.trashRetentionDays column + migration | locked |
| C2 | PER_TENANT_TRASH kind + 2 entries + validator | locked |
| C3 | sweepTrashEntry (enumerate→collect refs→delete→blob cleanup) | locked |
| C4 | sweepOnce dispatch (workerPrisma, own tx) | locked |
| C5 | TRASH_RETENTION_PURGED audit action | locked |
| C6 | DB role grant | locked |
| C7 | unit + integration tests | locked |

## Considerations
- **Blob-delete ordering**: refs MUST be collected before the cascade destroys the Attachment rows. External blob delete is best-effort post-commit (mirrors empty-trash; a failed external delete orphans an object but never leaves a dangling DB row). For the DB backend, `collectEntryAttachmentRefs` returns `[]` and the cascade removes the blob with the row — no external step.
- **Verification constraint (VC-blob)**: the real external-blob delete (S3/Azure/GCS) cannot run in CI (no bucket). Classification: blocked-deferred — the external path is unit-tested via a mocked blob store (assert the right refs are passed to deleteAttachmentBlobs); the DB-backend cascade is integration-tested on the live DB.
- **S1 (password_shares SetNull under auto-purge) — VERIFIED NOT A SECURITY ISSUE**: purging a trashed entry SetNulls `password_shares.password_entry_id` (pre-existing FK, shared with empty-trash). Confirmed the share-content route (`/api/share-links/[id]/content/route.ts:74-107`) serves the share's OWN `encryptedData` snapshot (NOT fetched via passwordEntryId) and is independently gated by `revokedAt`/`expiresAt`/`maxViews`. So SetNulling the entry link does not change content access — the share remains exactly as functional (or revoked/expired) as it was before the purge, identical to today's empty-trash behavior. No new guard needed; the entry link is provenance-only.
- **F2 (env not in worker .pick())**: `BLOB_BACKEND` + cloud config vars are read raw from `process.env` (after `loadEnv()`) by `getAttachmentBlobStore()`, not validated in the worker's env `.pick()`. Functionally fine; the worker fails at first sweep via `validateConfig()` rather than at boot. Acceptable — note it.
- Out of scope: policy API/UI for trashRetentionDays (column + worker only — follow-up); SC3/SC6/SC7.

## Scope contract
SC3/SC6/SC7 remain separate follow-ups. Policy API/UI for trashRetentionDays is a documented follow-up (this PR adds the column + the GC worker only).
