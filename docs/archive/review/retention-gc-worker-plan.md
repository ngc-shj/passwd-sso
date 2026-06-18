# Plan: retention-gc-worker

## Project context

- **Type**: service (Next.js + Prisma 7 + PostgreSQL 16) + background poll-loop workers.
- **Test infrastructure**: unit + integration (vitest) + real-DB integration (`npm run test:integration`, needs Postgres + SHARE_MASTER_KEY) + GitHub Actions CI.
- **Verification environment constraints**:
  - **VC1 — concurrent multi-process race / DELETE-only-expired on a live DB**: requires the real-DB integration harness. `verifiable-CI` (integration job runs Postgres). Pure registry/SQL-build/predicate-grammar tests are `verifiable-local`.
  - **VC2 — runtime boot of the new worker container** (R32): `docker compose up`. `verifiable-local`; ready signal declared in C8.
  - **VC3 — least-privilege DB role grant verification**: local dev runs as high-privilege owner so grant/RLS assertions pass vacuously (R16). The "role can DELETE registry tables but NOT audit_logs directly" assertion is `verifiable-CI` (CI creates the minimal role); `verifiable-local` only as a smoke test. **Requires harness + CI plumbing for the new role — see C10.**

## Objective

Add a single **generic retention-GC worker** that physically deletes rows whose retention/expiry has passed, driven by a **declarative table registry** — one entry per table, no per-table bespoke worker. Generalize the existing `dcr-cleanup-worker` (which already implements exactly this shape for one table) into the registry's first entry, and add audit-log per-tenant retention purge (the original user motivation).

**Why now**: A codebase audit found only 3 datasets have automatic GC (AuditOutbox/AuditDelivery via the outbox worker, McpClient-DCR via dcr-cleanup-worker). ~15 tables with expiry columns accumulate forever — storage bloat plus a forensics concern. The deletion logic for the *genuinely ephemeral* subset is structurally identical: `DELETE FROM <table> WHERE <cutoff_col> < now() [AND <predicate>]` — one generic engine + registry covers them.

**Scope was narrowed after plan-review round 1** (see Considerations): the initial registry includes ONLY tables that are (a) keyed by a column the engine can target, (b) free of `ON DELETE CASCADE` to live dependents, and (c) provenance-free OR provenance-duplicated-in-`audit_logs` (criterion clarified in the registry section below). Tables failing any test are deferred to dedicated SC PRs — they are NOT "the same essential operation."

## Requirements

### Functional

- FR1: A worker process loops on an interval; each sweep iterates the registry, deleting expired rows per entry, batch-bounded, single-flight (structural: await sweep before sleep), with per-entry error isolation (one entry's failure does not abort the others; the per-entry structured log line `{table, code}` is the authoritative error record — F7).
- FR2: The registry declares each table's GC rule with a closed set of entry *kinds*. Adding a table = one registry row (plus, for a non-`id` table, a key-column declaration).
- FR3: The worker emits a system audit heartbeat per sweep summarizing rows deleted per table.
- FR4: `audit_logs` GC honors each tenant's `Tenant.auditLogRetentionDays`, **clamped to a hard system minimum of `AUDIT_LOG_RETENTION_MIN` (30) days** (S4 — a tenant config below the floor never shortens retention below 30); `NULL` retention → tenant skipped (no implicit deletion); deletion routes through the existing `audit_log_purge(uuid, timestamptz)` SECURITY DEFINER function.
- FR5: The existing `dcr-cleanup-worker` is **absorbed**: DCR-cleanup becomes a registry entry; the standalone worker + all its deployment/test artifacts are retired in the same PR, with no double-deletion or GC gap (C9 enumerates the full surface).
- FR6: The audit-outbox retention (`purgeRetention` inside the outbox worker) is **left untouched** — it is part of the delivery state-machine lifecycle, not pure-expiry GC (SC1).

### Non-functional

- NFR1: Least-privilege DB role (NOSUPERUSER, NOBYPASSRLS) following the `passwd_outbox_worker` pattern; grants cover exactly the registry tables + the FK-referenced tables the heartbeat-emit path needs (R14). NO `audit_logs` DELETE/INSERT grant (S5/F5).
- NFR2: Worker never crashes on transient DB errors; logs `{code}`-only (and `{table, code}` on per-entry failure), never `err.message`, never the generated SQL/predicate string (S6).
- NFR3: Interval, batch, DB URL, audit-heartbeat toggle are env-configurable with Zod-validated defaults computed from time constants ([feedback_time_constants_computed]).
- NFR4: Idempotent / safe to run repeatedly and concurrently with the app (DELETE-by-cutoff is naturally idempotent).

## Technical approach

Generalize `src/workers/dcr-cleanup-worker.ts` → `src/workers/retention-gc-worker/`:
- `registry.ts` — declarative table registry (data only).
- `predicate.ts` — the structured predicate type + SQL renderer (S1 containment boundary).
- `sweep.ts` — `sweepExpiryEntry`, `sweepAuditLogs`, `sweepOnce`.
- `index.ts` — `createWorker(config)` poll loop, lifecycle parity with dcr-cleanup.
- `scripts/retention-gc-worker.ts` — entrypoint cloned from `scripts/dcr-cleanup-worker.ts`.

### Registry entry kinds (closed set)

```
type RetentionEntryKind = "EXPIRY" | "PER_TENANT_FN";

// Structured predicate — NOT free-form SQL (S1). Each clause's column runs the
// ^[a-z_]+$ allowlist; op is an enum; boolean/null values are rendered as SQL
// literals from a closed set, never interpolated from outside this file.
type PredicateClause =
  | { column: string; op: "IS NULL" | "IS NOT NULL" }
  | { column: string; op: "="; value: boolean };

interface ExpiryEntry {
  kind: "EXPIRY";
  table: string;            // physical table name (^[a-z_]+$)
  cutoffColumn: string;     // ^[a-z_]+$, e.g. "expires_at" | "expires"
  keyColumns: string[];     // columns forming the row identity for batched delete; ["id"] for id-keyed tables, ["identifier","token"] for verification_tokens
  predicate?: PredicateClause[];  // AND-joined; structured, not raw SQL
  // globalDelete: required `true` for every RLS-enabled table (the background
  // worker has no per-tenant context, so the cutoff delete spans all tenants
  // and MUST run under bypass_rls). Acknowledges the deliberate all-tenant
  // blast radius (S2/S10). Omit ONLY for RLS-free tables (verification_tokens).
  globalDelete?: true;
}

interface PerTenantFnEntry {
  kind: "PER_TENANT_FN";
  table: "audit_logs";
  fn: "audit_log_purge";
  tenantRetentionColumn: "auditLogRetentionDays";
}
```

- **EXPIRY** delete is batch-bounded and key-driven: `DELETE FROM <table> WHERE (<keyColumns>) IN (SELECT <keyColumns> FROM <table> WHERE <cutoffColumn> < now() [AND <rendered predicate>] LIMIT $1)`. Using `keyColumns` (not a hardcoded `id`) lets the SAME codepath handle `id`-keyed tables and the composite-key `verification_tokens` (F1/S8). The dcr-cleanup `USING ... WHERE table.id = sub.id` shape is replaced by the `(keys) IN (...)` shape, which is correct for both single and composite keys.
- **PER_TENANT_FN** (audit_logs): enumerate tenants with non-null `auditLogRetentionDays`, clamp to `max(retention, AUDIT_LOG_RETENTION_MIN)`, call `audit_log_purge(tenant.id, cutoff)` per tenant.

### Initial registry scope (the narrowed "本質的に対応する" set)

**EXPIRY entries** — id/key-targetable, NO cascade to live dependents (verified: the 4 non-DCR tables have zero inbound FK refs), and provenance-free OR provenance-duplicated-in-audit_logs (criterion clarified below):

| Table | cutoffColumn | keyColumns | predicate | globalDelete | model:line |
|-------|--------------|-----------|-----------|-----------|-----------|
| `mcp_clients` (DCR) | `dcr_expires_at` | `["id"]` | `[{column:"is_dcr",op:"=",value:true},{column:"tenant_id",op:"IS NULL"}]` | `true` (RLS-enabled) | McpClient:1888 (absorbs dcr-cleanup) |
| `sessions` | `expires` | `["id"]` | — | `true` (tenant-scoped, RLS) | Session:39 |
| `verification_tokens` | `expires` | `["identifier","token"]` | — | — (no RLS, no tenant_id) | VerificationToken:57 (composite PK, no `id`) |
| `extension_bridge_codes` | `expires_at` | `["id"]` | — | `true` (tenant-scoped, RLS) | ExtensionBridgeCode:248 |
| `mobile_bridge_codes` | `expires_at` | `["id"]` | — | `true` (tenant-scoped, RLS) | MobileBridgeCode:281 |
| `mcp_authorization_codes` | `expires_at` | `["id"]` | — | `true` (tenant-scoped, RLS) | McpAuthorizationCode:1917 (single-use codes) |

**Inclusion criterion (corrected — S11/F9)**: the original "no standalone forensic provenance" wording is factually wrong for `sessions`/`extension_bridge_codes`/`mobile_bridge_codes`, which DO carry `ip`/`userAgent` (schema:43-44, 251-252, 284-285). The honest criterion is: **either provenance-free, OR the provenance is transient session/exchange telemetry that is independently captured in `audit_logs`** (which the worker now retains ≥30 days). Verified: `audit_logs` carries `ip` + `userAgent` (schema:858-859) and `logAuditAsync` populates them (audit.ts:156-157). The login event (`AUTH_LOGIN`) records the session's IP/UA at creation, so deleting an expired `sessions` row past `expires` loses nothing the audit log didn't capture. **Verification (confirmed in plan-review round 3)**: both bridge-code exchange paths emit an audit event carrying IP/UA via `personalAuditBase(req, …)` → `extractRequestMeta` — `src/app/api/extension/token/exchange/route.ts:246` (`EXTENSION_TOKEN_EXCHANGE_SUCCESS`) and `src/app/api/mobile/token/route.ts:258` (`MOBILE_TOKEN_ISSUED`). So exchange-time provenance is independently captured in `audit_logs`; deleting an expired bridge-code row past `expires_at` loses nothing the audit log didn't record. The bridge tables stay in EXPIRY (NOT deferred to SC4). The C2 integration test should still assert this linkage is present (a regression guard against the audit emit being removed).

Used-but-unexpired single-use codes (`mcp_authorization_codes.usedAt`, `*_bridge_codes.usedAt`) are intentionally retained until `expires_at` — single-use rejection is enforced at consume time, not by GC (F10). Cutoff is `expires_at` only; this is the consistent delete-by-expiry policy across all single-use code tables.

**PER_TENANT_FN entry**:

| Table | fn | retention source |
|-------|----|-----------------|
| `audit_logs` | `audit_log_purge` | `Tenant.auditLogRetentionDays` (NULL → skip; clamped to ≥30) |

### Deliberately EXCLUDED (scope contract — each fails the "same essential operation" test)

- **SC1** — audit_outbox/audit_delivery: delivery state-machine, owned by outbox worker. Already automatic.
- **SC2** — soft-delete vault trash (`password_entries.deleted_at`, `team_password_entries.deleted_at`): cascade to encrypted `Attachment` blobs (R6); needs grace-period + blob-GC design. PR `retention-trash-purge`.
- **SC3** — password history (`PasswordEntryHistory`, `TeamPasswordEntryHistory`): per-entry retention policy decision. PR `retention-history-trim`.
- **SC4** — **forensic-provenance credentials** (`api_keys`, `service_account_tokens`, `operator_tokens`, `extension_tokens`, `delegation_sessions`): carry `lastUsedIp`/`lastUsedUserAgent`/named-identity binding (S3/F6). Deleting on expiry erases credential-provenance forensics. Needs retention-vs-forensics policy (longer retention, or emit-provenance-audit-before-delete). PR `retention-forensic-credentials`.
- **SC5** — **cascade-coupled tokens** (`mcp_access_tokens` + `mcp_refresh_tokens` rotation family): `mcp_access_tokens` has `ON DELETE CASCADE` to live `mcp_refresh_tokens` (7-day) and `delegation_sessions` — deleting a 1-hour-expired access token destroys still-valid refresh tokens, breaking OAuth refresh-rotation (F2, confirmed schema.prisma:1968/1991). `mcp_refresh_tokens` itself is also deferred here (it has its own `expires_at` but is part of the same `familyId` rotation lifecycle — F11). Needs family-aware deletion (delete only when the whole rotation family + delegation sessions are expired/revoked). PR `retention-mcp-token-family`.
- **SC6** — security-record expiry tables (`emergency_access_grants`, `access_requests`, `admin_vault_resets`, `master_key_rotations`, `personal_log_access_grants`, `password_shares`, `team_invitations`): records of security actions with forensic value. PR `retention-security-records`.
- **SC7** — append-only logs without cutoff columns (`ShareAccessLog`, `DirectorySyncLog`, `Notification`): need schema + policy.

## Contracts

### C1 — Registry + predicate model (`registry.ts`, `predicate.ts`) — locked

- **Signature**:
  ```
  export type RetentionEntry = ExpiryEntry | PerTenantFnEntry;
  export const RETENTION_REGISTRY: readonly RetentionEntry[];
  export function renderPredicate(clauses: PredicateClause[]): string;  // AND-joined, allowlisted columns, literal-only values
  ```
- **Invariants**:
  - INV-C1a (app-enforced via test): every `table`, `cutoffColumn`, and each `keyColumns[]`/predicate `column` resolves to a real Prisma table/column. The DMMF cross-check resolves physical names as `model.dbName ?? model.name` and `field.dbName ?? field.name` (T3 — `sessions.expires`/`verification_tokens.expires` have no `@map`, so `field.dbName` is `undefined`; the resolver must fall back to `field.name`). The regression assertion must verify the resolver **positively maps** `sessions.expires` → present-in-resolved-columns (T14) — not merely "does not throw"; a skip-undefined variant would also not throw, so the positive-presence assertion is what distinguishes a correct `?? name` fallback from a silent skip.
  - INV-C1b (app-enforced via test): for every EXPIRY entry, each `keyColumns` column exists AND the set is a valid row identity (each entry's `keyColumns` matches that model's `@id` or a `@@unique`). Fails at boot otherwise — turns F1's silent skip into a loud boot failure.
  - INV-C1c (app-enforced via test): predicate is a structured `PredicateClause[]` — there is NO free-form-SQL `string` predicate field anywhere (S1). `renderPredicate` runs every `column` through `^[a-z_]+$` and renders `value` only as the SQL literals `true`/`false` (op `=`) — no other value path exists.
  - INV-C1d: no duplicate `table` entries.
- **Forbidden patterns**:
  - `pattern: predicate\?\s*:\s*string` — reason: predicate must be structured, never a raw SQL string (S1).
  - `pattern: \$\{[^}]*(req|body|params|process\.env)` in registry/predicate/sweep — reason: SQL tokens never from runtime input.
- **Acceptance**: registry = 6 EXPIRY + 1 PER_TENANT_FN; DMMF cross-check (with `dbName ?? name`) passes; key-identity check passes; `renderPredicate` unit test asserts a bad column throws and a valid clause renders the exact expected SQL fragment.

### C2 — `sweepExpiryEntry` (`sweep.ts`) — locked

- **Signature**: `export async function sweepExpiryEntry(tx, entry: ExpiryEntry, batchSize: number): Promise<number>`
- **Invariants**:
  - INV-C2a: SQL built ONLY from `entry` literal fields (table/cutoffColumn/keyColumns/rendered-predicate) + `$1` batch param. Identifiers validated `^[a-z_]+$` at worker boot (not sweep time); non-match throws at boot.
  - INV-C2b (corrected — S10): bypass_rls GUC set in-tx for **every RLS-enabled table** — NOT only `tenant_id IS NULL` targets. Rationale (verified against migrations): the tenant-isolation policy is `USING (COALESCE(current_setting('app.bypass_rls', true),'')='on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)` (e.g. sessions policy, migration 20260227043000:380; uuid-cast form 20260321110000:404). A `NOBYPASSRLS` worker with no `app.tenant_id` set evaluates `''::uuid` → **`invalid input syntax for type uuid`** → the delete errors (caught per-entry → 0 rows forever). The existing dcr worker ALWAYS sets `bypass_rls=on` (dcr-cleanup-worker.ts:95) for exactly this reason, even though its target is `tenant_id IS NULL`. Therefore: the engine **requires** `globalDelete: true` on every RLS-enabled entry and runs it under bypass_rls; it throws at boot if an RLS-enabled tenant-scoped entry lacks the flag (forcing the author to acknowledge the deliberate all-tenant blast radius — S2). The ONLY entry that omits the flag is `verification_tokens` (no RLS, no tenant_id). bypass_rls makes the cutoff delete global-by-design, which is correct for GC (you want all tenants' expired rows gone).
  - INV-C2c: DELETE is batch-bounded via `(keys) IN (SELECT keys ... LIMIT $1)` — never unbounded.
- **Forbidden patterns**: `pattern: DELETE FROM (?!.*LIMIT)` — every GC delete batch-bounded.
- **Acceptance**: unit test asserts the generated SQL via **explicit string assertion** (NOT `toMatchSnapshot` — T7; repo has no snapshot infra): contains `IN (SELECT ... LIMIT $1)`, bound params exactly `[batchSize]`, no `${` of non-literal tokens; AND asserts the engine throws at boot when an RLS-enabled entry lacks `globalDelete` (both branches — S10/RT7). Integration test (real DB): deletes only expired, leaves unexpired, respects predicate, caps at batchSize. **Composite-key matrix (T12)**: a concrete `verification_tokens` case — ≥3 rows sharing one `identifier` with mixed `expires` (some past, some future) plus a distinct identifier — asserting (a) only the expired composite rows are deleted, (b) the unexpired same-`identifier` row survives, (c) batchSize caps composite-row deletion. This is the genuinely new `(identifier, token) IN (...)` codepath (replaces dcr's `WHERE table.id = sub.id`), so it gets its own enumerated matrix, not just "handles correctly".

### C3 — `sweepAuditLogs` (`sweep.ts`) — locked

- **Signature**: `export async function sweepAuditLogs(tx, entry: PerTenantFnEntry): Promise<number>`
- **Invariants**:
  - INV-C3a: enumerate only tenants with `auditLogRetentionDays IS NOT NULL`; cutoff = `now() - max(retention, AUDIT_LOG_RETENTION_MIN) days` (S4 floor).
  - INV-C3b: deletion ONLY via `audit_log_purge(tenantId, cutoff)` — never direct `DELETE FROM audit_logs` (the role has no audit_logs DELETE grant; mirrors purge-audit-logs/route.ts:73-77).
  - INV-C3c: runs under bypass_rls to read tenants + invoke the definer fn; heartbeat recording the purge is SYSTEM_TENANT_ID-scoped (the forensic anchor that survives the purge — S4) and is itself never subject to per-tenant purge.
- **Consumer-flow walkthrough**: output (per-sweep deleted count) consumed only by: (1) heartbeat-emit in `sweepOnce` (reads integer → `AUDIT_METADATA_KEY.PURGED_COUNT` per-table breakdown; no URL/AAD/signature); (2) loop log line (integer). No persisted/external shape → satisfied.
- **Acceptance**: integration test, 2 tenants (A retention=30d, B NULL): A's >30d rows deleted via the definer fn, A's recent kept, B untouched and never enumerated. **Mechanism check (T6)**: combined with C10's "role has no direct audit_logs DELETE", the row-state + no-direct-DELETE together enforce INV-C3b; assert the heartbeat per-table count attributes audit_logs deletion only to tenant A.

### C4 — `sweepOnce` + heartbeat (`sweep.ts`) — locked

- **Signature**: `export async function sweepOnce(workerPrisma, batchSize, opts: { intervalMs; emitHeartbeatAudit; _emitFn? }): Promise<Record<string, number>>`
- **Invariants**:
  - INV-C4a: each EXPIRY entry runs in its **own** `$transaction`; the audit heartbeat runs in a final separate tx after collecting counts.
  - INV-C4b: per-entry error isolation — a single entry's failure is caught, logged `{table, code}` (the **authoritative** error record — F7), and the sweep continues. The heartbeat also records errored entries, but the per-entry log line is authoritative because the final heartbeat tx may itself fail.
  - INV-C4c: heartbeat uses SYSTEM_TENANT_ID / SYSTEM_ACTOR_ID / ACTOR_TYPE.SYSTEM, action `AUDIT_ACTION.RETENTION_GC_SWEEP`.
- **Decision — per-entry tx, non-atomic heartbeat (deliberate R9 deviation)**: per-entry isolation requires separate txs (one rollback must not undo siblings). The heartbeat is therefore NOT atomic with the deletes. Acceptable because (a) DELETE-by-cutoff is idempotent (re-run re-counts 0), (b) the per-entry structured log is the durable record (same best-effort contract as `logAuditAsync`). Documented as a conscious deviation from dcr-cleanup's single-tx-with-emit (which had one table).
- **Acceptance**: integration test — one entry forced to throw still lets siblings delete; both branches observable (errored entry flagged + siblings' counts > 0). The old `dcr-cleanup-worker-tx-rollback` "emit-failure rolls back DELETE" assertion is **intentionally replaced** by an idempotency test with a **named deterministic failure-injection mechanism (T13)**: `sweepOnce` retains the `_emitFn?` override in its opts (kept from dcr-cleanup sweepOnce, dcr-cleanup-worker.ts:38/111); the test wires `_emitFn` to throw **in the final heartbeat tx specifically** (not the per-entry delete txs — INV-C4a runs the heartbeat in its own tx). Then assert: (1) rows were already deleted (per-entry txs committed before the heartbeat tx), (2) re-running `sweepOnce` returns all-zero counts (cutoff matches nothing → no double-delete). This proves idempotency, not atomicity. Do NOT simulate the failure via a non-deterministic DB-state hack.

### C5 — worker lifecycle + entrypoint — locked

- **Signature**: `createWorker(config: { databaseUrl; intervalMs; batchSize; emitHeartbeatAudit }): { start; stop }`.
- **Invariants**: lifecycle parity with dcr-cleanup (AbortController, single-flight by await-before-sleep, error-isolated loop, graceful stop). Pool `application_name: "passwd-sso-retention-gc-worker"`; pool `error` handler logs `{code}` only (S7).
- **Forbidden patterns**: `pattern: err\.message` and `pattern: console\.(log|error)\([^)]*sql` in worker/loop — log `{code}`/`{table,code}` only, never SQL/predicate (S6).
- **Acceptance**: `tsx scripts/retention-gc-worker.ts --validate-env-only` exits 0; SIGTERM finishes in-flight sweep then exit 0 — env-contract test `scripts/__tests__/retention-gc-worker-env.test.mjs` (new; mirrors the dcr one, explicit `toEqual` payload, no snapshot).

### C6 — audit action + env schema + constants — locked

- **AUDIT_ACTION.RETENTION_GC_SWEEP** added to (F4 — exact sites): (1) `AUDIT_ACTION` const (`src/lib/constants/audit/audit.ts:18`), (2) `AUDIT_ACTION_VALUES` (:219), (3) exactly one group — `AUDIT_ACTION_GROUP.MAINTENANCE` (~:715, alongside `AUDIT_OUTBOX_*`/`AUDIT_LOG_PURGE`), (4) `messages/en/AuditLog.json` AND `messages/ja/AuditLog.json` (ja must NOT be カタカナ per [feedback_ja_vault_translation]-style i18n rules — use a Japanese rendering). **Binding consumers / verification**: `src/__tests__/audit-action-group-coverage.test.ts` and `src/__tests__/audit-i18n-coverage.test.ts` must pass (R12).
- `MCP_CLIENT_DCR_CLEANUP` is retained (audit-action append-only convention) but becomes unused by the new path; the unified `RETENTION_GC_SWEEP` carries per-table metadata for the DCR entry.
- **Env schema** (`src/lib/env-schema.ts`): add `RETENTION_GC_DATABASE_URL`, `RETENTION_GC_INTERVAL_MS` (default 1h via `MS_PER_HOUR`), `RETENTION_GC_BATCH_SIZE` (default 1000), `RETENTION_GC_EMIT_HEARTBEAT_AUDIT` — mirror the DCR_CLEANUP_* block (:75-99). **Remove** the DCR_CLEANUP_* block — and propagate the removal to every consumer (C9).
- **Acceptance**: `npm run check:env-docs` passes; `.env.example` regenerated; defaults computed from time constants.

### C7 — DB role + grants migration — locked

- New migration `<ts>_add_retention_gc_worker_role/migration.sql`, mirroring `passwd_outbox_worker`:
  - Create `passwd_retention_gc_worker` (LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE).
  - `GRANT CONNECT ON DATABASE current_database()` (R15 — dynamic).
  - `REVOKE ALL ON SCHEMA public` + `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES/SEQUENCES` + `REVOKE REFERENCES` (S5 — full least-privilege pattern); `GRANT USAGE ON SCHEMA public`.
  - `GRANT SELECT, DELETE` on each EXPIRY table (`mcp_clients`, `sessions`, `verification_tokens`, `extension_bridge_codes`, `mobile_bridge_codes`, `mcp_authorization_codes`).
  - `GRANT SELECT` on `tenants` (PER_TENANT_FN enumeration + emit FK check); `GRANT EXECUTE` on `audit_log_purge(uuid, timestamptz)`.
  - `GRANT SELECT, INSERT` on `audit_outbox` (heartbeat emit writes here — NOT audit_logs). **No grant on `users`/`teams`/`service_accounts`** — corrected during Phase-2 self-R-check (R14): unlike the outbox-worker (which delivers to audit_logs and FK-checks those tables), this worker only enqueues to `audit_outbox` (whose sole FK is `tenants`) and reads `tenants` for the emit EXISTS check. `tenants` SELECT alone is sufficient.
  - **NO grant on `audit_logs`** (S5/F5 — emit goes to audit_outbox; audit_logs deletion via definer fn only).
  - **R14 completeness**: `(keys) IN (SELECT ...)` delete needs SELECT+DELETE on each table; bypass_rls GUC needs no grant.
- **DCR role decision**: leave `passwd_dcr_cleanup_worker` role intact-but-unused (dropping a role is destructive R31-adjacent + pre-1.0 churn). New role gets `mcp_clients` SELECT/DELETE.
- **Acceptance**: migration applies on dev DB with real data ([feedback_run_migration_on_dev_db]); CI minimal-role job confirms the role CAN delete each EXPIRY table and CANNOT delete audit_logs directly (R16; needs C10 plumbing).

### C8 — docker + package script — locked

- `package.json`: add `"worker:retention-gc": "tsx scripts/retention-gc-worker.ts"`; remove `"worker:dcr-cleanup"`.
- `docker-compose.override.yml`: add `retention-gc-worker` service cloned from `dcr-cleanup-worker` (`RETENTION_GC_DATABASE_URL` from `passwd_retention_gc_worker:${PASSWD_RETENTION_GC_WORKER_PASSWORD}`); remove the `dcr-cleanup-worker` service.
- Worker-password setter: add `scripts/set-retention-gc-worker-password.sh` + its `.mjs` test (mirror the dcr setter); retire the dcr setter + test (C9).
- **Acceptance (R32 ready signal)**: worker boots in docker shape, logs `retention-gc.loop_start {intervalMs, batchSize}` within 30s, then `retention-gc.sweep_done`. Boot log evidences DB connection as `passwd_retention_gc_worker` (pg_stat_activity application_name), not app role.

### C9 — full DCR-absorption surface (F3/T9/T10) — locked

The absorption touches more than C6/C8. Enumerate and update ALL in the same PR; decide each disposition:
- `infra/postgres/initdb/03-create-dcr-cleanup-worker-role.sql` → add a sibling `04-create-retention-gc-worker-role.sql` (fresh-Docker first-boot role bootstrap — the migration path does NOT run before app tables exist; the new role MUST exist at initdb time or the worker can't connect on a fresh stack). Keep `03` (role kept-but-unused) OR retire its grants — decide: **keep file, leave role**.
- `infra/k8s/dcr-cleanup-worker.yaml` → add `infra/k8s/retention-gc-worker.yaml`; remove the dcr one.
- `.github/workflows/ci-integration.yml` (:92-95 env, :133-164 bootstrap) → add `PASSWD_RETENTION_GC_WORKER_PASSWORD` env + `ALTER ROLE passwd_retention_gc_worker WITH LOGIN PASSWORD '<matches helpers.ts fallback>'`; the `paths:` filter already includes `src/workers/**` + `prisma/migrations/**`.
- `scripts/env-descriptions.ts` (:109,843,851,859) → replace DCR_CLEANUP_* descriptions with RETENTION_GC_* (else `check:env-docs` fails).
- `scripts/env-allowlist.ts` (:187,203) → swap `PASSWD_DCR_CLEANUP_WORKER_PASSWORD` → `PASSWD_RETENTION_GC_WORKER_PASSWORD`.
- `docker-compose.yml` (:47, db service) → swap the required `PASSWD_DCR_CLEANUP_WORKER_PASSWORD` var → new one (decide: keep both if the old role is retained, but the password is only needed if the role logs in — since the role is unused, remove the old required-var to avoid demanding an unused secret).
- **Acceptance**: `npm run check:env-docs` green; fresh `docker compose up` creates the new role at initdb and the worker connects (R32 boot test).

### C10 — test-harness + CI role plumbing (T1/T2) — locked

- `src/__tests__/db-integration/helpers.ts`: extend `TestRole` union with `"retention-gc-worker"`; `getConnectionString` adds the case (base→`passwd_retention_gc_worker:passwd_retention_gc_pass` substitution, with `RETENTION_GC_DATABASE_URL` env override); `TestContext` gains `retentionWorker`; `createTestContext`/`cleanup` instantiate/teardown it.
- The CI password (C9) MUST equal the `helpers.ts` fallback so CI auth succeeds.
- Disposition of the 3 existing dcr integration tests (T10): port `dcr-cleanup-worker-sweep.integration.test.ts`'s 9-row boundary matrix into the new EXPIRY/DCR test (T8 — asserts identical 1-deleted/8-kept, proving semantic equivalence to the retired path); replace `tx-rollback` with the C4 idempotency test; port `role` to the new role. Remove `ctx.dcrWorker` wiring only after.
- **Acceptance**: the role test connects AS `passwd_retention_gc_worker` (NOT su — RT5). The **positive control** (role CAN delete an EXPIRY table) and the **negative controls** (role CANNOT `DELETE FROM audit_logs` / `DELETE FROM tenants` → `permission denied`) MUST run against the **same `retentionWorker` client** (T11) — the negatives are what actually discriminate a minimal role from a leaked superuser connection (a su would pass the positive too); only the pair, on one client, fails closed. The allowlist test asserts a bad identifier throws at boot AND a good one does not (both branches — RT7).

### C11 — manual test plan (R35 Tier-1) — locked

- `docs/archive/review/retention-gc-worker-manual-test.md`: Pre-conditions / Steps / Expected / Rollback. Two-filter rule: include only (a) docker-shape boot (VC2), (b) least-privilege role smoke (VC3). Exclude what integration covers. No PII ([feedback_no_personal_email_in_docs]).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Registry + structured predicate model (6 EXPIRY + 1 PER_TENANT_FN; DMMF+key checks) | locked |
| C2 | sweepExpiryEntry (key-driven batch-bounded, identifier-allowlisted, explicit SQL assertion) | locked |
| C3 | sweepAuditLogs (per-tenant, ≥30 floor, via definer fn, SYSTEM-scoped anchor) | locked |
| C4 | sweepOnce + per-entry isolation + authoritative per-entry log + idempotency test | locked |
| C5 | worker lifecycle + entrypoint ({code}-only, no-SQL-log) | locked |
| C6 | audit action (exact 4 sites + 2 coverage tests) + env schema | locked |
| C7 | DB role + minimal grants (no audit_logs grant, REFERENCES revoke) | locked |
| C8 | docker service + package script (retire dcr-cleanup) | locked |
| C9 | full DCR-absorption surface (initdb/k8s/CI/env-docs/allowlist/compose) | locked |
| C10 | test-harness + CI role plumbing + dcr-test disposition | locked |
| C11 | manual test plan | locked |

## Testing strategy

- **Unit (verifiable-local)**: registry DMMF cross-check with `dbName ?? name` + regression on `sessions.expires` (T3); key-identity check (INV-C1b); `renderPredicate` bad-column-throws + exact-fragment (INV-C1c, S1); `sweepExpiryEntry` SQL **explicit string assertion** + params `[batchSize]` (T7); env-contract test (`--validate-env-only`).
- **Integration (real DB, verifiable-CI)**: EXPIRY correctness incl. composite-key `verification_tokens` (C2); PER_TENANT_FN honors per-tenant retention, ≥30 floor, NULL-skip + mechanism via no-direct-DELETE (C3/T6); per-entry error isolation + idempotency-after-heartbeat-failure (C4); least-privilege role CAN delete EXPIRY tables + CANNOT delete audit_logs (C7/C10, RT5 + positive control T5); DCR equivalence via ported 9-row boundary matrix (T8).
- **Single-flight (FR1)**: documented as structurally guaranteed (await-before-sleep) and consciously **untested**, matching dcr-cleanup precedent (T4) — OR an explicit non-overlap test asserting max concurrency == 1 with both branches observed (RT4). Decision: document-as-untested (parity with precedent); revisit if the loop ever moves to `setInterval`.
- **RT7**: each negative test proven able to go red (positive control for the role test; both-branch for the allowlist test).

## Considerations & constraints

### Scope contract
SC1–SC7 above. The narrowing from 13→6 EXPIRY tables happened in plan-review round 1 after experts proved (against the schema) that `verification_tokens` (keyless), `mcp_access_tokens` (cascade to live refresh tokens), and the provenance-bearing credential tables are NOT the same essential operation.

### Tracked follow-up (non-blocking)
- **S14 (Low)**: INV-C2b's "RLS-enabled entry lacking `globalDelete` → boot-throw" relies on the author correctly knowing which tables are RLS-enabled (a hand-declared fact vs the DB ground truth in `pg_policies`). For the 6 current entries this is verified correct, and C2's acceptance tests the throw on the known set. A future RLS-enabled table added to the registry *without* the flag would silently 0-row rather than throw. `TODO(retention-gc-worker): derive RLS-enabled status from pg_policies in the INV-C1a cross-check so the globalDelete requirement is enforced against ground truth, not author discipline.` Worst case: a future registry addition silently fails to GC (storage bloat, not a security bypass — bypass_rls is still required, just not auto-detected). Likelihood: low (registry edits are rare and reviewed). Cost to fix: ~30min (one extra `pg_policies` query in the cross-check test) — deferred only because it adds a DB dependency to a currently-pure-DMMF unit test; tracked here, not silently dropped.

### Risks
- **audit_log_purge coupling** (C3): pinned by integration test; signature confirmed `(UUID, TIMESTAMPTZ) RETURNS INTEGER`.
- **DCR absorption gap**: retire-old + add-registry-entry in ONE PR; verified by the ported boundary-matrix equivalence test + R32 boot test + initdb role bootstrap (C9).
- **RLS reach**: bypass_rls set per-entry only for global/`tenant_id IS NULL` targets (S2); tenant-scoped EXPIRY entries require explicit `globalDelete` ack.

### Out of scope
- UI for GC status/config (worker is operator infra; per-tenant audit retention already has UI).
- Cron/scheduler change (project uses poll-loop workers; we follow that).

## Implementation Checklist

**Files to CREATE:**
- `src/workers/retention-gc-worker/registry.ts` (C1) — types + RETENTION_REGISTRY
- `src/workers/retention-gc-worker/predicate.ts` (C1) — PredicateClause + renderPredicate
- `src/workers/retention-gc-worker/sweep.ts` (C2/C3/C4) — sweepExpiryEntry, sweepAuditLogs, sweepOnce
- `src/workers/retention-gc-worker/index.ts` (C5) — createWorker
- `scripts/retention-gc-worker.ts` (C5) — entrypoint (clone scripts/dcr-cleanup-worker.ts)
- `prisma/migrations/<ts>_add_retention_gc_worker_role/migration.sql` (C7)
- `infra/postgres/initdb/04-create-retention-gc-worker-role.sql` (C9)
- `infra/k8s/retention-gc-worker.yaml` (C9 — clone dcr-cleanup-worker.yaml)
- `scripts/set-retention-gc-worker-password.sh` + `scripts/__tests__/set-retention-gc-worker-password.test.mjs` (C8)
- `scripts/__tests__/retention-gc-worker-env.test.mjs` (C5 — clone dcr-cleanup-worker-env.test.mjs)
- unit tests: registry DMMF/key checks, predicate render, sweep SQL-build (C1/C2)
- integration tests: `src/__tests__/db-integration/retention-gc-worker-{sweep,role,audit-logs,error-isolation}.integration.test.ts` (C2/C3/C4/C10)
- `docs/archive/review/retention-gc-worker-manual-test.md` (C11)

**Files to MODIFY:**
- `src/lib/env-schema.ts:75-99` — replace DCR_CLEANUP_* block with RETENTION_GC_* (C6)
- `src/lib/constants/audit/audit.ts` — add `RETENTION_GC_SWEEP` to AUDIT_ACTION (after AUDIT_LOG_PURGE ~:79), AUDIT_ACTION_VALUES (~:219), AUDIT_ACTION_GROUP.MAINTENANCE (:715) (C6/R12)
- `messages/en/AuditLog.json` + `messages/ja/AuditLog.json` — add RETENTION_GC_SWEEP label (C6; ja non-katakana)
- `package.json:45` — `worker:dcr-cleanup` → `worker:retention-gc` (C8)
- `docker-compose.override.yml` — dcr-cleanup-worker service → retention-gc-worker (C8)
- `docker-compose.yml:47` — PASSWD_DCR_CLEANUP_WORKER_PASSWORD → PASSWD_RETENTION_GC_WORKER_PASSWORD (C9)
- `scripts/env-descriptions.ts:109,843-859` — DCR_CLEANUP_* → RETENTION_GC_* (C9)
- `scripts/env-allowlist.ts:187,203` — password var swap (C9)
- `.github/workflows/ci-integration.yml` — add PASSWD_RETENTION_GC_WORKER_PASSWORD env + ALTER ROLE (C9)
- `src/__tests__/db-integration/helpers.ts` — add "retention-gc-worker" TestRole + retentionWorker (C10)

**Files to RETIRE (in same PR):**
- `src/workers/dcr-cleanup-worker.ts`, `scripts/dcr-cleanup-worker.ts`, `infra/k8s/dcr-cleanup-worker.yaml`, `scripts/set-dcr-cleanup-worker-password.sh` + test, `scripts/__tests__/dcr-cleanup-worker-env.test.mjs`, 3 `dcr-cleanup-worker-*.integration.test.ts` (port per C10). KEEP `infra/postgres/initdb/03-...` + the dcr role (kept-but-unused, C7 decision).

**Shared utilities to REUSE (do NOT reimplement):**
- `src/lib/constants/time.ts` — MS_PER_HOUR/MS_PER_MINUTE/MS_PER_DAY (env defaults)
- `src/lib/validations/common.ts:223` — AUDIT_LOG_RETENTION_MIN (C3 floor)
- `src/lib/constants/app.ts` — SYSTEM_TENANT_ID, SYSTEM_ACTOR_ID
- `src/lib/constants/audit/audit.ts` — AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE, AUDIT_METADATA_KEY
- `src/workers/worker-pool-config.ts` — WORKER_POOL_IDLE_TIMEOUT_MS, WORKER_POOL_STATEMENT_TIMEOUT_MS
- `src/lib/env-schema.ts` — envObject (.pick pattern), audit_log_purge definer fn (existing)
- Pattern templates (clone, don't invent): `src/workers/dcr-cleanup-worker.ts`, `scripts/dcr-cleanup-worker.ts`

**CI gate parity**: ci-integration.yml triggers on `src/workers/**` + `prisma/migrations/**` (both touched). New role password must be ALTER ROLE'd in CI to match helpers.ts fallback `passwd_retention_gc_pass`.

## User operation scenarios
- **Operator deploys the worker**: `docker compose up` brings up `retention-gc-worker`; expired sessions/codes/DCR rows physically removed within the interval; counts logged. Per-tenant audit retention now automatic (manual `purge-audit-logs.sh` remains for ad-hoc/forced purge).
- **Tenant sets auditLogRetentionDays=90**: next sweep deletes that tenant's audit_logs older than 90d via the definer fn; a tenant trying to set 5 is clamped to the 30-day floor (S4). NULL → never auto-deleted.
- **A registry entry misconfigured**: that one entry errors, logged `{table, code}` (authoritative) + flagged in the heartbeat; all other tables still GC'd.
