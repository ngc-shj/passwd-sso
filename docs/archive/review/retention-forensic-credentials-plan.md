# Plan: retention-forensic-credentials (SC4)

## Project context
- Type: service (Next.js + Prisma 7 + PostgreSQL 16, multi-tenant RLS, least-privilege worker roles) + retention-GC worker (engine + SC5 EXPIRY_GUARDED merged).
- Test infra: unit + integration (real-DB) + CI.

## Objective
GC the **forensic-provenance credential tables** that #571 deferred (SC4): `api_keys`, `service_account_tokens`, `operator_tokens`, `extension_tokens`. These carry `lastUsedAt` / `lastUsedIp` / `lastUsedUserAgent` / actor-binding (`userId` / `subjectUserId` / `createdByUserId`) — deleting on expiry erases credential-provenance forensics. Per the chosen policy (**emit provenance to audit before delete**), each expired credential's provenance is recorded in `audit_logs` (via the audit outbox) immediately before deletion, so the forensic trail survives the GC.

**delegation_sessions is EXCLUDED** — SC5 already owns it (cascade-deleted with its mcp_access_token parent; a standalone expiry GC here would double-handle it).

## Provenance per table (verified against schema — corrected per plan review S1)
**All 4 tables have a NOT NULL `tenant_id` column + FORCE RLS** (verified: every table has a `*_tenant_isolation` policy of the standard `bypass_rls OR tenant_id = app.tenant_id` shape). The earlier "api_keys/extension_tokens lack tenant_id" note was wrong.

| Table | tenant | actor binding | usage telemetry | label |
|-------|--------|---------------|-----------------|-------|
| `api_keys` | `tenant_id` | `user_id` | `last_used_at` | `name` |
| `service_account_tokens` | `tenant_id` | `service_account_id` | `last_used_at` | `name` |
| `operator_tokens` | `tenant_id` | `subject_user_id`, `created_by_user_id` | `last_used_at` | `name` |
| `extension_tokens` | `tenant_id` | `user_id` | `last_used_at`, `last_used_ip`, `last_used_user_agent` | — |

**Tenant attribution (corrected — review S2)**: emit each credential's provenance audit under the **row's own `tenant_id`** (captured in `provenanceColumns`), NOT SYSTEM_TENANT_ID — so the forensic record lands in the owning tenant's audit log (the tenant's compliance export/admin can see it). `enqueueAuditInWorkerTx` verifies tenant existence and works under bypass_rls, so per-row tenant works unchanged. All 4 entries set `globalDelete: true` (RLS-enabled); none go in `RLS_FREE_EXPIRY_TABLES`.

## Technical approach
Add a new registry kind **`EXPIRY_AUDIT_PROVENANCE`**. Per sweep, for each such entry, in ONE transaction:
1. `SELECT <provenanceColumns> FROM <table> WHERE <cutoffColumn> < now() LIMIT $1 FOR UPDATE SKIP LOCKED` — capture the rows to delete + their provenance (FOR UPDATE SKIP LOCKED avoids racing the app revoking/using them).
2. For each captured row: `enqueueAuditInWorkerTx(tx, row.tenant_id, { action: CREDENTIAL_RETENTION_PURGED, metadata: { table, credentialId, ...provenance } })` — under the row's OWN tenant (corrected, review S2).
3. `DELETE FROM <table> WHERE id = ANY(<captured ids>)`.
All atomic: if the audit emit fails, the delete rolls back (the provenance MUST be durably enqueued before the row is destroyed — this is the whole point, so unlike the heartbeat this emit IS atomic with the delete).

### Registry entry
```
interface AuditProvenanceEntry {
  kind: "EXPIRY_AUDIT_PROVENANCE";
  table: string;
  cutoffColumn: string;
  /** Physical columns captured into the audit metadata before deletion (allowlisted). */
  provenanceColumns: string[];
  globalDelete?: true;  // RLS-enabled tables
}
```
Provenance column lists are registry data but allowlist-validated (`^[a-z_]+$`) like keyColumns — they are SELECT-projection identifiers, never predicate values, so S1 containment holds.

## Contracts

### C1 — registry kind + entries + validator — locked
- Extend `RetentionEntryKind` with `"EXPIRY_AUDIT_PROVENANCE"`; add `AuditProvenanceEntry`; add 4 entries (api_keys, service_account_tokens, operator_tokens, extension_tokens), each with cutoffColumn `expires_at`, `globalDelete: true` (all RLS-enabled — confirmed), and `provenanceColumns` that MUST include `tenant_id` (for per-row emit) + the table's actor/telemetry/label columns.
- **Validator (review S1/S3)**: add an `EXPIRY_AUDIT_PROVENANCE` branch to `validateRegistry` (index.ts) that runs `assertIdentifier` on table, cutoffColumn, and every `provenanceColumn`, AND enforces `globalDelete` for RLS-enabled tables (same rule as EXPIRY — none are in RLS_FREE_EXPIRY_TABLES). Currently the validator has no such branch.
- Invariant: provenanceColumns allowlist-validated at boot AND in the sweeper; DMMF cross-check (registry.test.ts) extended to cover table + cutoffColumn + every provenanceColumn (review S3/T2).

### C2 — sweepAuditProvenanceEntry — locked
- `sweepAuditProvenanceEntry(tx, entry, batchSize): Promise<number>`:
  - `assertIdentifier` on table, cutoffColumn, every provenanceColumn (defensive, mirrors sweepExpiryEntry).
  - bypass_rls (globalDelete is always true for these).
  - `SELECT id, <provenanceColumns> FROM <table> WHERE <cutoffColumn> < now() LIMIT $1 FOR UPDATE SKIP LOCKED` (projection columns from the allowlisted list; `tenant_id` is in the list).
  - For each row: build an `AuditOutboxPayload` with `action: CREDENTIAL_RETENTION_PURGED`, `actorType: SYSTEM`, metadata `{ table, credentialId: row.id, ...provenance }` (length-cap string provenance — userAgent — before storing); call `enqueueAuditInWorkerTx(tx, row.tenant_id, payload)` — **the row's own tenant** (review S2), so the audit lands in the owning tenant's log.
  - `DELETE FROM <table> WHERE id = ANY($N::uuid[])` with the captured ids.
  - Return count.
- Invariant: emit-before-delete is atomic (same tx); a failed emit rolls back the delete (provenance durability). Only `$1` (batch) + the id array are bound; column identifiers allowlist-validated.

### C3 — sweepOnce dispatch — locked
- Add explicit `else if (entry.kind === "EXPIRY_AUDIT_PROVENANCE")` branch.

### C4 — new audit action — locked
- Add `AUDIT_ACTION.CREDENTIAL_RETENTION_PURGED` to the const + AUDIT_ACTION_VALUES + MAINTENANCE group + en/ja AuditLog.json (ja non-katakana). + Prisma `AuditAction` enum + a separate enum migration (R24 add-then-use split, like RETENTION_GC_SWEEP).

### C5 — DB role grant — locked
- Grant `passwd_retention_gc_worker` `SELECT, DELETE` on the 4 tables. (No cascade concern — these are leaf credentials; verify no inbound CASCADE that would orphan. extension_tokens has a familyId self-ref? check.) audit_outbox INSERT already granted (#571).

### C6 — tests — locked
- Unit: sweepAuditProvenanceEntry SQL shape (SELECT projection + FOR UPDATE SKIP LOCKED + DELETE ... id = ANY); provenance column allowlist rejection.
- Integration (real DB): (a) expired credential → audit_outbox row written with provenance metadata BEFORE the credential row is deleted (assert both); (b) emit failure → delete rolls back (credential survives — atomicity, via _emitFn-style injection or a forced constraint); (c) non-expired credential untouched; (d) batchSize cap; (e) role-grant positive+negative.
- RT7: the atomicity test (emit fails → row survives) proves the provenance-durability guarantee can fire.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | EXPIRY_AUDIT_PROVENANCE kind + 4 entries | locked |
| C2 | sweepAuditProvenanceEntry (capture→emit→delete, atomic) | locked |
| C3 | sweepOnce dispatch | locked |
| C4 | CREDENTIAL_RETENTION_PURGED audit action + enum migration | locked |
| C5 | DB role grant (4 tables SELECT+DELETE) | locked |
| C6 | unit + integration tests | locked |

## Considerations
- **Why atomic emit (vs heartbeat best-effort)?** The provenance audit is the WHOLE POINT — if the credential is deleted but the provenance emit is lost, forensics are gone. So unlike the RETENTION_GC_SWEEP heartbeat (best-effort), this emit MUST be in the same tx as the delete and roll back together.
- **No FOR UPDATE SKIP LOCKED** (corrected during impl): Postgres requires UPDATE privilege for a FOR UPDATE row lock, and the GC role intentionally has only SELECT+DELETE (granting UPDATE would over-privilege it). Since the capture targets only already-expired rows that the app never deletes (only this worker does), there is no SELECT→DELETE race to lock against — the captured id list is stable, and the audit emits exactly for the ids subsequently deleted.
- **tenant resolution**: all 4 tables have a NOT NULL `tenant_id` (captured in provenanceColumns) → emit under the row's own tenant so the forensic record lands in the owning tenant's audit log (review S2 correction).
- Out of scope: delegation_sessions (SC5 owns); SC2/SC3/SC6/SC7 separate.

## Scope contract
SC2/SC3/SC6/SC7 remain separate follow-ups. delegation_sessions handled by SC5.
