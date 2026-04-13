# Plan: Durable Audit Backend (Transactional Outbox)

Source design input: [`durable-audit-outbox-design-input.md`](./durable-audit-outbox-design-input.md)

## Project context

- **Type**: web app + service (Next.js 16 / Prisma 7 / PostgreSQL 16)
- **Test infrastructure**: unit tests (vitest) + limited integration tests + E2E + CI/CD.
  Real-Postgres integration tests are present in `src/__tests__/integration/` but most existing audit tests are mocked. The known integration test gap (memory: `project_integration_test_gap`) is directly relevant — the outbox's atomicity invariant cannot be verified without a real DB. This plan addresses that gap.
- **Test obligations apply**: Major/Critical findings recommending tests are in scope.

## Objective

Replace the current best-effort, in-memory audit retry buffer with a **durable, transactional outbox** so that:

1. **No silent audit loss**: business write succeeds ⇒ audit row exists, even on crash.
2. **No false success**: audit write failure cannot be hidden behind a fire-and-forget `void` call.
3. **Reliable bounded retry**: retries are persisted, observable, backed off, and dead-lettered.
4. **Multi-target fan-out** (Stage 3): SIEM / object-storage / webhook delivery is decoupled from the request path and isolated per-target.
5. **Optional tamper-evidence** (Stage 4): hash-chain rows for high-assurance compliance.

Stages 1–4 are all in scope per user direction; Phases 1–4 below correspond.

## Background — what exists today

Survey results (file:line):

- [`src/lib/audit.ts:102-215`](../../src/lib/audit.ts) — `logAudit()` is **fire-and-forget async** (`void (async () => { ... })()`). The DB write happens AFTER the calling request handler returns. On failure it falls into [`src/lib/audit-retry.ts:56-65`](../../src/lib/audit-retry.ts) (in-memory bounded buffer of 100, drained piggyback on the next call). On process restart, buffered entries are lost.
- [`src/lib/audit.ts:231-344`](../../src/lib/audit.ts) — `logAuditBatch()` mirrors the same fire-and-forget pattern with `createMany`.
- [`src/lib/tenant-rls.ts:5-12`](../../src/lib/tenant-rls.ts) — `BYPASS_PURPOSE.AUDIT_WRITE` already exists. Used by both `logAudit` and `audit-retry`.
- [`src/lib/audit.ts:34-37`](../../src/lib/audit.ts) — webhook re-entry already suppressed for `WEBHOOK_DELIVERY_FAILED` / `TENANT_WEBHOOK_DELIVERY_FAILED` to avoid R13 loops.
- [`src/lib/audit.ts:179`](../../src/lib/audit.ts) — webhook dispatcher is **lazy-imported** to break the audit ↔ webhook circular dependency (R10 already mitigated).
- [`src/lib/webhook-dispatcher.ts:107-183`](../../src/lib/webhook-dispatcher.ts) — SSRF defense lives here as **non-exported** internal helpers (`BLOCKED_CIDRS`, `isPrivateIp`, `resolveAndValidateIps`, `createPinnedDispatcher`). These need to be extracted for Stage 3 reuse.
- [`src/app/api/maintenance/purge-audit-logs/route.ts`](../../src/app/api/maintenance/purge-audit-logs/route.ts) — canonical maintenance-endpoint pattern: `verifyAdminToken` → rate limiter (1/min) → operator membership check → `withBypassRls` work → `logAudit` → JSON response.
- [`src/lib/admin-token.ts:12-31`](../../src/lib/admin-token.ts) — `verifyAdminToken()` uses `timingSafeEqual` on SHA-256 of bearer token (RS1-safe).
- [`infra/postgres/initdb/02-create-app-role.sql`](../../infra/postgres/initdb/02-create-app-role.sql) — `passwd_app` role: `LOGIN NOSUPERUSER NOBYPASSRLS`, granted SELECT/INSERT/UPDATE/DELETE on all public tables. RLS is FORCEd by [`prisma/migrations/20260228020000_force_rls_and_scim_trigger_phase9/migration.sql`](../../prisma/migrations/20260228020000_force_rls_and_scim_trigger_phase9/migration.sql).
- [`prisma/schema.prisma:919-946`](../../prisma/schema.prisma) — `AuditLog` model + RLS policy `audit_logs_tenant_isolation` (USING / WITH CHECK on `app.bypass_rls = 'on' OR tenant_id = current_setting('app.tenant_id')`).
- [`prisma/schema.prisma:497`](../../prisma/schema.prisma) — `Tenant.auditLogRetentionDays Int?` already exists; purge endpoint already enforces it.
- **No background worker / queue infrastructure** exists in the repo. Existing periodic tasks (`/api/maintenance/purge-audit-logs`, `/api/maintenance/dcr-cleanup`, `/api/maintenance/purge-history`, `/api/admin/rotate-master-key`) are HTTP POST endpoints triggered externally (cron, k8s CronJob, etc.). The outbox worker MUST follow the same pattern — see "Worker invocation model" below.
- 187 call sites of `logAudit` across `src/`. 17 metadata blocklist keys (`METADATA_BLOCKLIST`); webhook dispatcher uses superset `WEBHOOK_METADATA_BLOCKLIST` (22 keys).
- `enum AuditAction` has ~130 values; `enum ActorType { HUMAN, SERVICE_ACCOUNT, MCP_AGENT, SYSTEM }`. SYSTEM is currently unused — outbox worker rows will use `actorType = SYSTEM`. **S9 fix**: `audit_logs.userId` is currently `String NOT NULL @db.Uuid` with FK to `users`. Worker-emitted `AUDIT_OUTBOX_*` events have no associated User. Phase 2 migration makes `userId` nullable: `userId String? @map("user_id") @db.Uuid` with a CHECK constraint `(actor_type = 'SYSTEM' AND user_id IS NULL) OR (user_id IS NOT NULL)`. This also fixes the existing latent bug in `webhook-dispatcher.ts:343` which passes `userId: "system"` (violates UUID + FK). The existing `audit_logs` RLS policy and indexes must be updated to handle NULL `userId`.
- [`src/lib/constants/audit.ts:269-607`](../../src/lib/constants/audit.ts) — `AUDIT_ACTION_GROUP` + per-scope mappings + `TENANT_WEBHOOK_EVENT_GROUPS` / `TEAM_WEBHOOK_EVENT_GROUPS`. New audit actions added by Phase 2 must be wired into all of these.
- i18n: [`messages/en/AuditLog.json`](../../messages/en/AuditLog.json) and [`messages/ja/AuditLog.json`](../../messages/ja/AuditLog.json).

## Requirements

### Functional

| # | Requirement |
|---|---|
| F1 | Phase 1: write `audit_outbox` rows in the **same DB transaction** as the business mutation. No fire-and-forget for outbox enqueue. |
| F2 | Phase 1: a worker process reads `pending` rows in FIFO-by-`createdAt` order, marks them `processing`, copies them into `audit_logs`, marks them `sent`. |
| F3 | Phase 1: failed deliveries follow exponential backoff via `next_retry_at`; after `max_attempts` they become `failed` (dead-letter). |
| F4 | Phase 2: stuck `processing` rows older than `processing_timeout` are reset to `pending` by a reaper. |
| F5 | Phase 2: operational metrics endpoint (`pending`, `oldest_pending_age`, `processing`, `failed`, `dead_letter`, `avg_attempts`). |
| F6 | Phase 2: deprecate `audit-retry.ts`. After Phase 2 lands, `logAudit()` writes to outbox (single persistent path); the in-memory buffer code is deleted. **Exception (F12 fix)**: worker meta-events (`AUDIT_OUTBOX_*` actions in `OUTBOX_BYPASS_AUDIT_ACTIONS`) are written directly to `audit_logs` by the worker, bypassing the outbox to prevent R13 loops. These are the ONLY audit rows allowed to have `outboxId = NULL`. A test enforces this invariant. |
| F7 | Phase 3: pluggable delivery targets — DB (always), webhook (existing dispatcher, deduplicated), SIEM (Splunk/Datadog HEC), object storage (S3/GCS). Per-target failure isolation via per-target row-level state. |
| F8 | Phase 3: SSRF defense for SIEM/storage URLs reuses extracted helpers from `webhook-dispatcher.ts`. |
| F9 | Phase 4 (optional, behind tenant flag): hash chain (`prev_hash`, `event_hash`, `chain_seq`) per tenant, with concurrent-insert-safe ordering. |
| F10 | **Source-compatibility only**: the 187 existing `logAudit()` call sites must continue to **compile and run** without per-call-site changes. `logAudit` keeps the same `(params) => void` signature. **However, F1's atomicity guarantee (business write ⇔ audit row) is NOT provided by the void-returning `logAudit`** — it is only available via the new `logAuditInTx(tx, params)`. `logAudit` is marked `@deprecated` in JSDoc with a pointer to `logAuditInTx`. Phase 1 also migrates the **security-critical** call sites (`CREDENTIAL_ACCESS`, `VAULT_UNLOCK`, `SHARE_LINK_ACCESSED`, `AUTH_LOGIN`, `AUTH_LOGOUT` groups) to `logAuditInTx`; the remaining call sites are tracked in a follow-up sweep. |
| F11 | Webhook re-entry suppression (R13) extends to outbox **starting from Phase 1** (T10/S16 fix — not deferred to Phase 2): the `OUTBOX_BYPASS_AUDIT_ACTIONS` set and bypass logic are wired in Phase 1 (initially containing `WEBHOOK_DELIVERY_FAILED` and `TENANT_WEBHOOK_DELIVERY_FAILED`). Phase 2 adds 3 worker-emitted actions (`AUDIT_OUTBOX_REAPED`, `AUDIT_OUTBOX_DEAD_LETTER`, `AUDIT_OUTBOX_RETENTION_PURGED`) to the bypass set. The 2 admin-endpoint actions (`AUDIT_OUTBOX_METRICS_VIEW`, `AUDIT_OUTBOX_PURGE_EXECUTED`) flow through the normal outbox and are NOT in the bypass set but ARE in `WEBHOOK_DISPATCH_SUPPRESS`. See §2.1 canonical table. |
| F12 | The outbox row stores its own `target_tenant_id` (the tenant the eventual `audit_logs` row belongs to) explicitly — no late tenantId resolution in the worker. |
| F13 | Existing audit tests (`src/__tests__/audit.test.ts`, `src/lib/audit-retry.test.ts`) and the integration test `src/__tests__/integration/audit-and-isolation.test.ts` must continue to pass after API-internal rewrite, OR be updated to match the new contract. |

### Non-functional

| # | Requirement |
|---|---|
| N1 | Throughput: sustained ≥ 1000 audit events/sec on a single worker on the project's reference dev DB. (Validation criterion, not guarantee.) |
| N2 | Worst-case end-to-end latency from outbox enqueue to `sent` ≤ 2× worker poll interval under healthy conditions. |
| N3 | Worker is a separate Node process (not a route handler) and connects as a **dedicated DB role** with the minimum privileges needed (P2-S2). For development, the role is created in the existing `infra/postgres/initdb/` setup. |
| N4 | All outbox writes and worker reads run inside `withBypassRls(prisma, ..., BYPASS_PURPOSE.AUDIT_WRITE)`. The worker's DB role MUST also have RLS bypass disabled at the role level (`NOBYPASSRLS`); access is only via the GUC, identical to `passwd_app`. |
| N5 | **Layered sanitization**: `sanitizeMetadata` (existing, [audit.ts:73-93](../../src/lib/audit.ts), uses `METADATA_BLOCKLIST` — 17 crypto/secret keys) is applied **before** the row is written to the outbox payload. **Each delivery target kind MUST apply the appropriate blocklist before outbound serialization**: DB target → `METADATA_BLOCKLIST` (already applied at enqueue). All external targets (WEBHOOK, SIEM_HEC, S3_OBJECT) → `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` (renamed from `WEBHOOK_METADATA_BLOCKLIST`, 22 keys — adds PII keys: `email`, `targetUserEmail`, `reason`, `incidentRef`, `displayName`, `justification`, `requestedScope`). The sanitizer function `sanitizeForExternalDelivery` is extracted from [`webhook-dispatcher.ts:81-100`](../../src/lib/webhook-dispatcher.ts) to [`src/lib/audit-logger.ts`](../../src/lib/audit-logger.ts) alongside the blocklist constants. Phase 1 webhook dispatch reuses existing `dispatchWebhook`/`dispatchTenantWebhook` (which sanitize internally); Phase 3 deliverers MUST call `sanitizeForExternalDelivery()` before outbound HTTP. |
| N6 | All operations are observable via existing `getLogger()` (pino) — structured logs for enqueue, claim, deliver, fail, dead-letter, reap. |

## Threat model

| # | Threat | Mitigation |
|---|---|---|
| TM1 | Worker process compromise | Dedicated DB role `passwd_outbox_worker`, granted only `SELECT, UPDATE, DELETE` on `audit_outbox` (DELETE constrained to `status IN ('SENT','FAILED')` via **mandatory** `BEFORE DELETE` trigger — the sole DB-level defense against audit evidence destruction) and `INSERT` on `audit_logs`, plus `SELECT` on `tenants`. NO access to `passwords`, `users`, secrets, sequences, or functions. NOSUPERUSER NOBYPASSRLS. |
| TM2 | Outbox row tampering between enqueue and delivery (Phase 4) | Hash chain per tenant (Phase 4 only). |
| TM3 | SSRF via SIEM/storage URL (Phase 3) | Extracted `validateExternalUrl()` from webhook-dispatcher with same `BLOCKED_CIDRS` + `createPinnedDispatcher()`. URL allowlist per tenant configuration. |
| TM4 | Sensitive metadata leakage to outbox row | `sanitizeMetadata()` applied before insert. The outbox `payload_json` MUST be the sanitized form. |
| TM5 | Hash chain race / concurrent insert reordering (Phase 4) | Per-tenant `SELECT … FOR UPDATE` on the chain anchor row, OR a tenant-scoped `chain_seq` integer column that is allocated by the worker (single writer per tenant per chain), not at enqueue time. We will use the **worker-allocated chain_seq** approach because enqueue happens on a hot path; design defers chain computation to the single-writer worker. |
| TM6 | Stuck `processing` row blocks the queue indefinitely | Reaper job (Phase 2) resets `processing` rows whose `processing_started_at < now() - processing_timeout` back to `pending` and increments `attempt_count`. |
| TM7 | Replay / double-delivery on worker crash mid-flight | At-least-once delivery is acceptable for audit logs (idempotent insert into `audit_logs` keyed by outbox `id` — see schema below). Worker treats `audit_logs.outboxId` unique constraint as the dedup boundary. |
| TM8 | Re-entrant outbox loop: outbox failure → audit log → outbox enqueue → ... | Worker-emitted meta-events (`AUDIT_OUTBOX_REAPED`, `AUDIT_OUTBOX_DEAD_LETTER`, `AUDIT_OUTBOX_RETENTION_PURGED`) are in `OUTBOX_BYPASS_AUDIT_ACTIONS` — the worker writes these directly to `audit_logs` (skipping the outbox). All 5 `AUDIT_OUTBOX_*` actions (including admin-endpoint-emitted `METRICS_VIEW` and `PURGE_EXECUTED`) are in `WEBHOOK_DISPATCH_SUPPRESS`. See §2.1 canonical table for the definitive membership. |
| TM9 | Worker DB role privilege escalation through Postgres function calls | The role has only DML on the two specific tables; no `EXECUTE` on schema functions, no `USAGE` on extensions. |
| TM10 | Outbox table grows unboundedly | Phase 2 reaper purges `sent` rows older than `outbox_retention_hours` (default 24 h) **AND** `failed` rows older than `outbox_failed_retention_days` (default 90 d). The 90 d default for failed rows preserves them long enough for an operator to investigate and (if needed) replay; a longer-lived dead-letter sink is a separate admin export. Both retention windows are env-overridable. A new admin endpoint `POST /api/maintenance/audit-outbox-purge-failed` exists for operator-driven explicit purges. |

## Technical approach

### Phase 1 — Outbox table + atomic write helper + worker (DB target only)

#### 1.1 New Prisma model

Add to [`prisma/schema.prisma`](../../prisma/schema.prisma):

```prisma
enum AuditOutboxStatus {
  PENDING
  PROCESSING
  SENT
  FAILED
}

model AuditOutbox {
  id                   String            @id @default(uuid(4)) @db.Uuid
  tenantId             String            @map("tenant_id") @db.Uuid
  // Snapshot of the audit row to insert. Sanitized at enqueue time.
  payload              Json
  status               AuditOutboxStatus @default(PENDING)
  attemptCount         Int               @default(0) @map("attempt_count")
  maxAttempts          Int               @default(8) @map("max_attempts")
  createdAt            DateTime          @default(now()) @map("created_at")
  nextRetryAt          DateTime          @default(now()) @map("next_retry_at")
  processingStartedAt  DateTime?         @map("processing_started_at")
  sentAt               DateTime?         @map("sent_at")
  lastError            String?           @map("last_error") @db.VarChar(1024)

  // Use Restrict (mirrors AuditLog at prisma/schema.prisma:938) — tenant deletion
  // is already blocked while audit_logs reference it; the outbox is the same boundary.
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  // Worker-friendly index: cheap claim of next pending batch
  @@index([status, nextRetryAt])
  // Tenant-scoped status queries (for the metrics endpoint)
  @@index([tenantId, status, createdAt])
  // Reaper index: find stuck PROCESSING rows
  @@index([status, processingStartedAt])
  @@map("audit_outbox")
}
```

`AuditLog` gains a unique `outboxId String? @unique` column for at-least-once dedup (TM7):

```prisma
model AuditLog {
  ...
  outboxId String? @unique @map("outbox_id") @db.Uuid
  ...
}
```

#### 1.2 Migration

Two raw-SQL migrations under `prisma/migrations/`, following the convention from [`20260411123230_add_extension_bridge_codes`](../../prisma/migrations/20260411123230_add_extension_bridge_codes/migration.sql):

1. **`<ts>_add_audit_outbox/migration.sql`**:
   - `CREATE TYPE "AuditOutboxStatus" AS ENUM ('PENDING','PROCESSING','SENT','FAILED');`
   - `CREATE TABLE "audit_outbox" (...)` with all columns + FK to `tenants`.
   - `CREATE INDEX` for the three indexes above.
   - `ALTER TABLE "audit_logs" ADD COLUMN "outbox_id" UUID;`
   - `CREATE UNIQUE INDEX "audit_logs_outbox_id_key" ON "audit_logs" ("outbox_id");`
   - `ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_outbox_id_actor_type_check" CHECK (outbox_id IS NOT NULL OR actor_type = 'SYSTEM');` — DB-level enforcement that only SYSTEM-actor rows (worker meta-events) may have NULL `outboxId` (S28 fix).
   - `ALTER TABLE "audit_outbox" ENABLE ROW LEVEL SECURITY;`
   - `ALTER TABLE "audit_outbox" FORCE ROW LEVEL SECURITY;`
   - RLS policy `audit_outbox_tenant_isolation` mirroring `audit_logs_tenant_isolation` (`USING / WITH CHECK` on `app.bypass_rls = 'on' OR tenant_id = current_setting('app.tenant_id')`).

2. **`<ts>_add_audit_outbox_worker_role/migration.sql`** (raw SQL, idempotent guards):
   - **Migration creates the role WITHOUT a password** (Prisma migration runs as `passwd_user` against the live DB and Postgres allows passwordless role creation when invoked by a superuser). The password is set out-of-band by the same `infra/postgres/initdb/02-create-app-role.sql` script, which reads `PASSWD_OUTBOX_WORKER_PASSWORD` from the environment via psql `\getenv` — exactly mirroring the existing `passwd_app` pattern. **Never** put a literal password in the migration SQL.
   - `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_outbox_worker') THEN CREATE ROLE passwd_outbox_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;`
   - `GRANT CONNECT ON DATABASE passwd_sso TO passwd_outbox_worker;`
   - `GRANT USAGE ON SCHEMA public TO passwd_outbox_worker;`
   - `GRANT SELECT, UPDATE, DELETE ON TABLE "audit_outbox" TO passwd_outbox_worker;` — DELETE is needed by the Phase 2 reaper to purge SENT/FAILED rows. **MANDATORY**: add a `BEFORE DELETE` trigger constraining DELETE to `status IN ('SENT','FAILED')` — prevents a compromised worker from deleting PENDING rows (audit evidence destruction). This is the sole DB-level defense for TM1; it is NOT optional (F25/S20 fix). Concrete DDL (S29 fix):
     ```sql
     CREATE OR REPLACE FUNCTION audit_outbox_before_delete_guard() RETURNS trigger AS $$
     BEGIN
       IF OLD.status NOT IN ('SENT', 'FAILED') THEN
         RAISE EXCEPTION 'Cannot delete audit_outbox row with status=%', OLD.status;
       END IF;
       RETURN OLD;
     END;
     $$ LANGUAGE plpgsql;
     CREATE TRIGGER trg_audit_outbox_before_delete
       BEFORE DELETE ON audit_outbox FOR EACH ROW
       EXECUTE FUNCTION audit_outbox_before_delete_guard();
     ```
     Integration test asserts `DELETE WHERE status='PENDING'` raises an exception.
   - `GRANT INSERT ON TABLE "audit_logs" TO passwd_outbox_worker;`
   - `GRANT SELECT ON TABLE "tenants" TO passwd_outbox_worker;` (for tenantId FK validation only).
   - **No sequence grants**: UUID PKs do not require sequences. Omitting `USAGE, SELECT ON ALL SEQUENCES` is a deliberate least-privilege decision per TM1/TM9.
   - `REVOKE ALL ON SCHEMA public FROM passwd_outbox_worker;` first, then explicit GRANTs (defense in depth).
   - Note: `passwd_outbox_worker` is **not** a tenant member; the worker always operates via `withBypassRls(...)` so RLS bypass is required at runtime via the GUC, identical to `passwd_app`.
   - Update `infra/postgres/initdb/02-create-app-role.sql` with a parallel section creating `passwd_outbox_worker` so dev environments get the role on first boot (password via `\getenv PASSWD_OUTBOX_WORKER_PASSWORD`, fallback to `passwd_outbox_pass` for local dev — identical pattern to `passwd_app`).
   - **S26 fix**: the initdb section for `passwd_outbox_worker` MUST include `REVOKE ALL ON SCHEMA public FROM passwd_outbox_worker;` BEFORE the explicit GRANTs, mirroring the existing `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` (line 24) defense-in-depth pattern.
   - **S30 fix**: also add `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM passwd_outbox_worker;` and `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM passwd_outbox_worker;` to prevent future table/sequence additions from automatically granting access to the worker role.
   - **F11 fix — Production password rollout**: add `scripts/set-outbox-worker-password.sh` (mirroring `scripts/purge-history.sh` pattern) that connects as superuser and runs `ALTER ROLE passwd_outbox_worker WITH PASSWORD '...'`. The script reads the password from `PASSWD_OUTBOX_WORKER_PASSWORD` env var. Document in `docs/operations/audit-outbox-worker.md`. This is the concrete step for existing clusters where initdb has already run.

#### 1.3 New helper: `enqueueAudit()` and `enqueueAuditBatch()`

New module [`src/lib/audit-outbox.ts`](../../src/lib/audit-outbox.ts):

```ts
export interface AuditOutboxPayload {
  scope: AuditScope;
  action: AuditAction;
  userId: string | null; // null when actorType = SYSTEM (worker meta-events, S9/F21 fix)
  actorType: ActorType;
  serviceAccountId: string | null;
  teamId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null; // already truncated + sanitized
  ip: string | null;
  userAgent: string | null;
}

/**
 * Enqueue an audit row into the outbox in the given Prisma transaction
 * client. The caller MUST be inside a transaction. tenantId MUST be
 * provided — no late resolution.
 */
export async function enqueueAuditInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<void> { ... }
```

The `tx` argument makes the dependency on the caller's transaction explicit and statically checkable. It eliminates the R9 problem (`void asyncFn()` inside a transaction) by removing the `void`.

For call sites that are NOT inside a `prisma.$transaction()`, a wrapper opens a one-shot tx wrapping a single `withBypassRls`:

```ts
export async function enqueueAudit(payload: AuditOutboxPayload, tenantId: string): Promise<void> {
  // withBypassRls wraps fn inside prisma.$transaction(async (tx) => { ... })
  // and runs tenantRlsStorage.run({ tx, ... }, fn). The tx is available
  // inside the callback as the first argument to $transaction, NOT via
  // getTenantRlsContext() — the ALS store is set for fn's scope only.
  // Use prisma.$transaction directly to get the tx reference:
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.bypass_purpose', ${BYPASS_PURPOSE.AUDIT_WRITE}, true)`;
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${NIL_UUID}, true)`;
    await enqueueAuditInTx(tx, tenantId, payload);
  });
}
```

Note: this duplicates the GUC-setting logic from `withBypassRls` but avoids the need to extract `tx` from the ALS store. An alternative is to refactor `withBypassRls` to pass `tx` into the callback (`fn(tx)`); that change is scoped to [`src/lib/tenant-rls.ts`](../../src/lib/tenant-rls.ts) and benefits all callers. **Recommended approach**: refactor `withBypassRls` signature to `withBypassRls<T>(prisma, fn: (tx) => Promise<T>, purpose)` in Phase 1.

**Contract enforcement for `enqueueAuditInTx` (R5/F12)**: the helper accepts a `Prisma.TransactionClient` parameter, which is statically the only way to call it. To prevent misuse where a caller pulls `tx` from somewhere outside an active `withBypassRls` (and therefore writes a row that the RLS policy will reject), the helper performs a runtime guard:

```ts
export async function enqueueAuditInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<void> {
  // Guard: assert the GUC is set. The GUC is per-transaction (set_config(..., true))
  // and only `withBypassRls` and `withTenantRls` set it. If neither is on, the RLS
  // policy will reject the write — fail fast with a clear error instead.
  const [{ bypass_rls, tenant_id }] = await tx.$queryRaw<{ bypass_rls: string; tenant_id: string }[]>`
    SELECT current_setting('app.bypass_rls', true) AS bypass_rls,
           current_setting('app.tenant_id', true)  AS tenant_id`;
  // Guard 1: RLS scope check — are we inside withBypassRls or withTenantRls?
  if (bypass_rls !== "on" && tenant_id !== tenantId) {
    throw new Error(
      `enqueueAuditInTx called outside withBypassRls/withTenantRls scope; ` +
      `bypass_rls=${bypass_rls}, tenant_id=${tenant_id}, expected=${tenantId}`,
    );
  }
  // Guard 2 (S6 fix): even under bypass, verify the tenantId actually exists.
  // Prevents cross-tenant audit misattribution from copy-paste tenantId errors.
  const [tenantExists] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantId}::uuid) AS ok`;
  if (!tenantExists?.ok) {
    throw new Error(
      `enqueueAuditInTx: tenantId ${tenantId} does not exist — refusing to write orphan outbox row`,
    );
  }
  await tx.auditOutbox.create({ data: { tenantId, payload } });
}
```

This converts a silent RLS rejection (returning `0 rows affected`) into a loud error at the boundary. Same pattern can be applied to other future RLS-bypassed helpers; not extracted to a shared utility yet (single use).

#### 1.4 Internal rewrite of `logAudit()` / `logAuditBatch()`

Both functions in [`src/lib/audit.ts`](../../src/lib/audit.ts) are rewritten to:

> **Design decision (revised after round-1 review):**
>
> **Two paths, clearly separated.**
>
> **Path A — `logAuditInTx(tx, params)` (atomic, no crash-loss):**
> The PREFERRED path. Caller passes a `Prisma.TransactionClient` from their existing `$transaction` or `withBypassRls` scope. `enqueueAuditInTx` writes the outbox row inside the caller's transaction. If the business tx commits, the outbox row exists. If it rolls back, both roll back. **This is the only path that delivers the F1 atomicity guarantee.**
>
> **Path B — `logAudit(params)` (source-compatible, NOT atomic, DEPRECATED):**
> Kept for the 187 existing call sites that are not yet migrated. Marked `@deprecated` in JSDoc with a pointer to `logAuditInTx`. Its body:
>
> 1. Synchronously constructs the row payload (sanitize + truncate metadata).
> 2. **TenantId resolution is ASYNC** (moved to the flusher, not synchronous). The FIFO entry stores `{ params, unresolvedTenantId: params.tenantId ?? null, teamId: params.teamId ?? null, userId: params.userId }` — the flusher resolves tenantId via a `withBypassRls` lookup when draining, identical to today's `logAudit` async closure (lines 119–134).
> 3. Submits the entry to a **process-local in-memory FIFO** (max 200 entries, FIFO eviction to `deadLetterLogger`).
> 4. The flusher is a `setInterval` with `.unref()` (default `OUTBOX_FLUSH_INTERVAL_MS` = 250 ms). It drains the queue into the outbox via `withBypassRls` in batches (≤ 100). On per-entry tenantId resolution failure, that entry is dead-lettered; remaining entries proceed (per-entry failure isolation). On batch-level DB error, entries stay in the FIFO with a retry counter (≤ 3 attempts → dead-letter).
> 5. **SIGTERM/SIGINT handler**: registers `process.on('SIGTERM', ...)` that calls the flusher synchronously with a 5 s timeout, then exits. `process.on('beforeExit', ...)` calls the flusher as a last-chance drain.
> 6. **AsyncLocalStorage isolation (S15 fix)**: the flusher MUST wrap its work in `tenantRlsStorage.run(undefined, async () => { ... })` to detach from any inherited request-scoped context. This prevents cross-tenant audit misattribution during shutdown drains.
> 7. **Runtime warning**: if `getTenantRlsContext()` is already set when `logAudit` is called (meaning the caller is inside an active `withBypassRls` or `withTenantRls`), emit a one-shot `getLogger().warn(...)` recommending migration to `logAuditInTx`.
>
> **Crash-loss surface of Path B**: entries in the in-memory FIFO that have not yet been flushed to the outbox are lost on SIGKILL. This is the **same** loss surface as today's `logAudit`. The SIGTERM handler reduces the window.
>
> **Phase 1 also migrates security-critical call sites to Path A**: the `CREDENTIAL_ACCESS` / `VAULT_UNLOCK` / `SHARE_LINK_ACCESSED` / `AUTH_LOGIN` / `AUTH_LOGOUT` action groups are inventoried and migrated to `logAuditInTx` in Phase 1 itself (estimated ~15 call sites). The remaining ~170 call sites are tracked in a follow-up ticket.
>
> **Phase 2 cleanup**: the FIFO + flusher (Path B internals) are deleted. A new `logAuditAsync(params): Promise<void>` replaces `logAudit` for the post-Phase-2 sweep; it `await`s `enqueueAudit` directly. The legacy `logAudit` shim becomes a thin wrapper that calls `void logAuditAsync(...).catch(...)` and is scheduled for removal.

#### 1.5 New helper for callers already inside a transaction

Endpoints that already wrap their work in `prisma.$transaction(...)` (e.g., bulk operations, key rotation) get a new explicit helper:

```ts
import { logAuditInTx } from "@/lib/audit";

await prisma.$transaction(async (tx) => {
  // ... business writes ...
  await logAuditInTx(tx, { scope, action, userId, tenantId: ..., ... });
});
```

`logAuditInTx` is the **preferred** path for new code and for any call site that already has a transaction. It makes the atomicity guarantee real. The Phase-2 follow-up (out of scope for Phase 1 plan) is to migrate the 187 call sites; Phase 1 only adds the helper and uses it in the new outbox-related paths.

#### 1.6 Worker process

New file [`src/workers/audit-outbox-worker.ts`](../../src/workers/audit-outbox-worker.ts) and entrypoint [`scripts/audit-outbox-worker.ts`](../../scripts/audit-outbox-worker.ts).

The worker is a small Node script that:

1. Boots a Prisma client connecting via `OUTBOX_WORKER_DATABASE_URL` (separate env var pointing at `passwd_outbox_worker`).
2. Loops — **two-transaction design** (F19 fix: single-tx rollback would undo the claim, preventing retry backoff):

   **Transaction 1 (Claim)**: atomically marks a batch as `PROCESSING`:

   - **Claim**: `UPDATE audit_outbox SET status='PROCESSING', processing_started_at=now() WHERE id IN (SELECT id FROM audit_outbox WHERE status='PENDING' AND next_retry_at <= now() ORDER BY created_at ASC LIMIT $batchSize FOR UPDATE SKIP LOCKED) AND status = 'PENDING' RETURNING *;`. The outer `AND status = 'PENDING'` is a belt-and-suspenders re-assertion (S12 fix). The `FOR UPDATE SKIP LOCKED` makes multi-worker safe. Worker hand-declares `AuditOutboxRow` TypeScript type matching the raw SQL columns (F14 fix).
   **Transaction 2 (Deliver)**: for EACH claimed row, in its own transaction:
   - **Insert**: `INSERT INTO audit_logs (..., outbox_id, created_at) VALUES (..., $outboxId, $row.created_at) ON CONFLICT (outbox_id) DO NOTHING` (raw SQL). **The `ON CONFLICT DO NOTHING` is the dedup mechanism** (F8/S10 fix). **`created_at` is copied from the outbox row, not `now()`** (F15 fix) — preserves business-event time.
   - **On success**: update outbox row to `SENT` + `sentAt = now()`. If `ON CONFLICT DO NOTHING` returned 0 rows affected, still mark `SENT` (already delivered = success).
   - **On error (Transaction 3 — independent error-recovery tx)**: if tx 2 fails, open a NEW transaction to increment `attempt_count`, set `next_retry_at = now() + backoff(attempt_count)`, set `status = PENDING` (ready for next claim cycle). If `attempt_count >= max_attempts`, set `status = FAILED` (dead-letter). **This MUST be a separate tx 3** because tx 2's rollback would undo any state changes made within it (F26 fix). If tx 3 also fails (DB completely down), the row stays `PROCESSING` and will be caught by the reaper after `processing_timeout`.
   - **Webhook dispatch**: runs AFTER tx 2 commits (not inside). Reuses `dispatchWebhook`/`dispatchTenantWebhook` (which sanitize internally via `WEBHOOK_METADATA_BLOCKLIST`). Lazy import preserved.
   - **R13 bypass set (moved from Phase 2 to Phase 1, per T10/S16 fix)**: the worker checks `OUTBOX_BYPASS_AUDIT_ACTIONS` before enqueuing any worker-emitted meta-events. In Phase 1 the set contains `WEBHOOK_DELIVERY_FAILED` and `TENANT_WEBHOOK_DELIVERY_FAILED` (matching the existing suppress set). Phase 2 adds 3 worker-emitted actions to the bypass set (`REAPED`, `DEAD_LETTER`, `RETENTION_PURGED`). The 2 admin-endpoint actions (`METRICS_VIEW`, `PURGE_EXECUTED`) are NOT in the bypass set — they flow through the normal outbox path (see §2.1 canonical table). The bypass logic is wired in Phase 1 so Phase 2 deployment ordering is safe.
3. Backoff: exponential with full jitter, capped at 1 hour. (`min(2^attempt * 1s + random(0..1s), 3600s)`)
   - **R1 — shared utility extraction**: there is no project-wide backoff helper today (verified: only [`src/lib/webhook-dispatcher.ts:56`](../../src/lib/webhook-dispatcher.ts) defines a local `RETRY_DELAYS` constant). Phase 1 introduces a single shared helper [`src/lib/backoff.ts`](../../src/lib/backoff.ts) (`computeBackoffMs(attempt, opts)` and `withFullJitter(ms)`). Both the new outbox worker AND the existing webhook-dispatcher are migrated to use it (the latter as a small refactor in the same PR — webhook-dispatcher's existing `RETRY_DELAYS` becomes a thin wrapper that calls `computeBackoffMs` with capped attempts). This avoids reimplementing backoff and avoids creating a Phase-1 fork that another PR has to clean up.
4. Sleeps `WORKER_POLL_INTERVAL_MS` (default 1000) when no rows claimed, otherwise immediately re-polls until a poll returns 0.
5. SIGTERM / SIGINT: drain in-flight, then exit.
6. **Concurrency**: rows in `PROCESSING` are owned by exactly one worker by virtue of `SKIP LOCKED` + the row state machine. Multiple workers can run concurrently safely.

**R2 — Constants live in one module**: all numeric constants (`OUTBOX_BATCH_SIZE` (default **500**, chosen so that at 1 s poll interval, N1's ≥1000 events/sec is achievable with 2 polls), `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_PROCESSING_TIMEOUT_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_HOURS`, `OUTBOX_FAILED_RETENTION_DAYS`, `READY_PENDING_THRESHOLD`, `READY_OLDEST_THRESHOLD`, `OUTBOX_FLUSH_INTERVAL_MS`, `OUTBOX_REAPER_INTERVAL_MS` (default 30000)) are defined in [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts) (the existing audit constants module) under a new `AUDIT_OUTBOX` namespace. The worker and the metrics endpoint import from there. Each constant has an env-var override resolved once at module load via a small `envInt(name, default)` helper. **No magic numbers in worker or route handler files.**

**Worker invocation model**: because there is no existing background-process infra, the worker runs as:
- **Production**: a separate Node process (k8s `Deployment` with replicas=1, or `CronJob` for batched runs). Plan ships the script + a sample k8s manifest in [`infra/k8s/audit-outbox-worker.yaml`](../../infra/k8s/audit-outbox-worker.yaml). Choosing Deployment (long-running poll loop) over CronJob keeps latency low; CronJob is fine for environments that prefer it.
- **Development**: `npm run worker:audit-outbox` runs the script via tsx; documented in CLAUDE.md.
- **Docker compose dev**: a new `audit-outbox-worker` service in [`docker-compose.yml`](../../docker-compose.yml) uses the same image, runs `node dist/scripts/audit-outbox-worker.js`. (Stage 1 may defer the docker-compose addition to keep dev surface unchanged; default: include it from Phase 1.)

#### 1.7 Deprecate `audit-retry.ts` (deferred to Phase 2 to limit Phase 1 blast radius)

Phase 1 leaves [`src/lib/audit-retry.ts`](../../src/lib/audit-retry.ts) **in place but unused on the success path** — `logAudit` still calls `enqueue()` only on the new pre-outbox buffer overflow case. Phase 2 deletes the file and its tests after the outbox is verified in production.

### Phase 2 — Operational metrics + reaper + deprecation

#### 2.1 New audit actions (registered everywhere)

New entries added to `enum AuditAction` in [`prisma/schema.prisma`](../../prisma/schema.prisma) (R12 — must be wired into all groups + i18n):

| Action | Group | Webhook? | In `OUTBOX_BYPASS`? | In `WEBHOOK_SUPPRESS`? |
|---|---|---|---|---|
| `AUDIT_OUTBOX_REAPED` | new `MAINTENANCE` group | No | Yes (worker direct-write) | Yes |
| `AUDIT_OUTBOX_DEAD_LETTER` | new `MAINTENANCE` group | No | Yes (worker direct-write) | Yes |
| `AUDIT_OUTBOX_RETENTION_PURGED` | new `MAINTENANCE` group | No | Yes (worker direct-write) | Yes |
| `AUDIT_OUTBOX_METRICS_VIEW` | new `MAINTENANCE` group | No | No (admin endpoint, uses normal logAudit) | Yes |
| `AUDIT_OUTBOX_PURGE_EXECUTED` | new `MAINTENANCE` group | No | No (admin endpoint, uses normal logAudit) | Yes |

**Canonical definition of `OUTBOX_BYPASS_AUDIT_ACTIONS`** (the set of actions that the WORKER writes directly to `audit_logs`, bypassing the outbox — to prevent R13 loops):
- Phase 1 initial: `WEBHOOK_DELIVERY_FAILED`, `TENANT_WEBHOOK_DELIVERY_FAILED` (carried over from existing `WEBHOOK_DISPATCH_SUPPRESS`)
- Phase 2 additions: `AUDIT_OUTBOX_REAPED`, `AUDIT_OUTBOX_DEAD_LETTER`, `AUDIT_OUTBOX_RETENTION_PURGED`

`AUDIT_OUTBOX_METRICS_VIEW` and `AUDIT_OUTBOX_PURGE_EXECUTED` are NOT in the bypass set — they are emitted by admin HTTP endpoints (not the worker) and flow through the normal outbox path. They ARE in `WEBHOOK_DISPATCH_SUPPRESS` because they should not trigger webhook delivery.

**TM8 threat model section must match this canonical set.** The TM8 example list (`AUDIT_OUTBOX_DELIVERY_FAILED`, `AUDIT_OUTBOX_DEAD_LETTER`, `AUDIT_OUTBOX_REAPED`) is hereby replaced by this table.

Implementation checklist for each action (R12):
- [`prisma/schema.prisma`](../../prisma/schema.prisma): `enum AuditAction` add value (5 separate `ALTER TYPE ... ADD VALUE` statements — one per action — per the existing migration convention)
- [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts): `AUDIT_ACTION` object + `AUDIT_ACTION_VALUES` array
- [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts): new `AUDIT_ACTION_GROUP.MAINTENANCE = "group:maintenance"`
- [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts): `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.MAINTENANCE]` array (all 5 actions)
- [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts): `AUDIT_ACTION_GROUPS_PERSONAL` and `AUDIT_ACTION_GROUPS_TEAM` — **MUST NOT include** the MAINTENANCE group (these are tenant-scope system events only)
- [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts): `TENANT_WEBHOOK_EVENT_GROUPS` — **MUST exclude** `MAINTENANCE` (R11/R13 — not subscribable; prevents loop)
- [`messages/en/AuditLog.json`](../../messages/en/AuditLog.json) + [`messages/ja/AuditLog.json`](../../messages/ja/AuditLog.json): action labels + group label `groupMaintenance`
- Tests in `src/lib/constants/audit.test.ts` (if exists; create if not): coverage assertion that every `AUDIT_ACTION_VALUES` entry appears in at least one of `_PERSONAL`/`_TEAM`/`_TENANT` groups.

The webhook-suppress set in [`src/lib/audit.ts:34-37`](../../src/lib/audit.ts) gains all four `AUDIT_OUTBOX_*` actions.

The outbox **enqueue** path also gains a sibling suppress set: `OUTBOX_BYPASS_AUDIT_ACTIONS` — when the worker emits one of these, it writes directly to `audit_logs` (skipping the outbox) so the worker can never block on its own meta-events.

**R13 — Suppression-set audit (mandatory checklist)**: every audit-action filter set in the codebase must be reviewed when adding `AUDIT_OUTBOX_*` actions. The known sets to update or verify (search for the new actions and ensure they appear or are explicitly excluded as required):

- [`src/lib/audit.ts`](../../src/lib/audit.ts): `WEBHOOK_DISPATCH_SUPPRESS` — **MUST include** all 5 `AUDIT_OUTBOX_*` actions (REAPED, DEAD_LETTER, RETENTION_PURGED, METRICS_VIEW, PURGE_EXECUTED).
- [`src/lib/audit.ts`](../../src/lib/audit.ts) **new**: `OUTBOX_BYPASS_AUDIT_ACTIONS` — **MUST include** the 3 worker-emitted actions only (REAPED, DEAD_LETTER, RETENTION_PURGED). MUST NOT include METRICS_VIEW or PURGE_EXECUTED (these are admin-endpoint actions that flow through the normal outbox).
- [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts): `TENANT_WEBHOOK_EVENT_GROUPS` — **MUST exclude** the new `MAINTENANCE` group entirely (the group containing the four actions).
- [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts): `TEAM_WEBHOOK_EVENT_GROUPS` — N/A (TEAM scope only; MAINTENANCE is TENANT scope), but verify nothing accidentally adds MAINTENANCE here.
- [`src/lib/constants/audit.ts`](../../src/lib/constants/audit.ts): `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` and `TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS` — derived from group arrays; verify the flatten step does not include MAINTENANCE.
- Any future analytics/forwarder filter (e.g., a fluent-bit-driven action filter): grep `WEBHOOK_DISPATCH_SUPPRESS|OUTBOX_BYPASS_AUDIT_ACTIONS|action.*===.*AUDIT_OUTBOX|isOutboxMetaEvent|isAuditMetaEvent` before merging.

The Phase 2 test `audit-bypass-coverage.test.ts` (see Testing strategy) enforces this checklist by static assertion.

#### 2.2 Reaper

In the worker loop, every `REAPER_INTERVAL_MS` (default 30 s):

```sql
UPDATE audit_outbox
SET status = 'PENDING',
    processing_started_at = NULL,
    attempt_count = attempt_count + 1,
    last_error = LEFT('[reaped after timeout, attempt ' || (attempt_count + 1)::text || ']', 1024)
WHERE id IN (
  SELECT id FROM audit_outbox
  WHERE status = 'PROCESSING'
    AND processing_started_at < now() - make_interval(secs => $processingTimeoutMs / 1000.0)
  FOR UPDATE SKIP LOCKED
)
RETURNING id;
```

Each reaped row triggers an `AUDIT_OUTBOX_REAPED` event written **directly** to `audit_logs` (bypassing the outbox to avoid recursion).

The same loop also purges `SENT` rows older than `OUTBOX_RETENTION_HOURS` (default 24 h) and `FAILED` rows older than `OUTBOX_FAILED_RETENTION_DAYS` (default 90 d):

```sql
-- Use make_interval() with bind parameters to avoid SQL injection via string concat (F23/S21 fix)
DELETE FROM audit_outbox
WHERE (status = 'SENT'   AND sent_at    < now() - make_interval(hours => $outboxRetentionHours))
   OR (status = 'FAILED' AND created_at < now() - make_interval(days  => $outboxFailedRetentionDays));
```

A single summary `AUDIT_OUTBOX_RETENTION_PURGED` is emitted (with a metadata count of how many rows were deleted in each status), not per-row.

A separate admin endpoint `POST /api/maintenance/audit-outbox-purge-failed` allows operator-driven explicit purges of `FAILED` rows by tenant, time range, or all (TM10). **Mandatory envelope (S11 fix)**: `verifyAdminToken` from [`src/lib/admin-token.ts`](../../src/lib/admin-token.ts), `createRateLimiter(windowMs: 60_000, max: 1)` from [`src/lib/rate-limit.ts`](../../src/lib/rate-limit.ts), operator membership check via `withBypassRls(...SYSTEM_MAINTENANCE)`, Zod validation on request body (`{ operatorId: z.string().uuid(), tenantId?: z.string().uuid(), olderThanDays?: z.number().int().min(1) }`), and audit log via `logAudit({ action: AUDIT_ACTION.AUDIT_OUTBOX_PURGE_EXECUTED, ... })` (new action, wired into MAINTENANCE group + i18n + suppress sets).

#### 2.3 Metrics endpoint

New file [`src/app/api/maintenance/audit-outbox-metrics/route.ts`](../../src/app/api/maintenance/audit-outbox-metrics/route.ts), following the [`purge-audit-logs`](../../src/app/api/maintenance/purge-audit-logs/route.ts) pattern: `verifyAdminToken` from [`src/lib/admin-token.ts`](../../src/lib/admin-token.ts), `createRateLimiter` from [`src/lib/rate-limit.ts`](../../src/lib/rate-limit.ts) (windowMs 60_000, max 6 — admin metric reads are intentionally less restrictive than mutating endpoints), operator membership check via `withBypassRls(...SYSTEM_MAINTENANCE)`, query, `logAudit`, JSON. **Reuses the existing rate limiter helper — no ad-hoc limiter.**

```http
GET /api/maintenance/audit-outbox-metrics
Authorization: Bearer <ADMIN_API_TOKEN>
```

Response:
```json
{
  "pending": 12,
  "processing": 1,
  "failed": 0,
  "oldestPendingAgeSeconds": 4,
  "averageAttemptsForSent": 1.02,
  "deadLetterCount": 0,
  "asOf": "2026-04-12T..."
}
```

The endpoint queries via `withBypassRls(prisma, ..., SYSTEM_MAINTENANCE)`, and emits `AUDIT_OUTBOX_METRICS_VIEW` to `audit_logs`. **S18 note**: the metrics endpoint returns **global** (cross-tenant) aggregates. It is intended for infrastructure operators only, not tenant admins. Document this scope in the endpoint's JSDoc.

A second JSON shape for liveness probe inclusion is exposed via [`src/lib/health.ts`](../../src/lib/health.ts) extension: the readiness check fails (503) when `pending > READY_PENDING_THRESHOLD` (default 10000) OR `oldestPendingAgeSeconds > READY_OLDEST_THRESHOLD` (default 600). Both thresholds are env-configurable.

#### 2.4 Delete `audit-retry.ts`

After Phase 2 lands (and the worker has been observed healthy), delete:
- [`src/lib/audit-retry.ts`](../../src/lib/audit-retry.ts)
- [`src/lib/audit-retry.test.ts`](../../src/lib/audit-retry.test.ts)
- All imports of `enqueue`, `bufferSize`, `drainBuffer`, `BufferedAuditEntry` from [`src/lib/audit.ts`](../../src/lib/audit.ts)

The pre-outbox emergency buffer in `audit.ts` (introduced in Phase 1.4) is also removed at this point — by Phase 2 the outbox enqueue path is the only persistent path, and any DB-down condition will surface as a structured error and enter the dead-letter logger directly.

### Phase 3 — Multiple delivery targets

#### 3.1 Refactor: extract SSRF helpers + sanitization

[`src/lib/webhook-dispatcher.ts:107-183`](../../src/lib/webhook-dispatcher.ts) — move `BLOCKED_CIDRS`, `isPrivateIp`, `resolveAndValidateIps`, `createPinnedDispatcher` into a new shared module [`src/lib/external-http.ts`](../../src/lib/external-http.ts) and re-export them from `webhook-dispatcher.ts` to keep its current internal API unchanged.

**P3-F3/S6 fix**: Also extract into `external-http.ts`:
- `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` (renamed from `WEBHOOK_METADATA_BLOCKLIST`, extended with PII keys). `webhook-dispatcher.ts` re-exports the old name as an alias for backward compatibility.
- `sanitizeForExternalDelivery(value)` (extracted from `sanitizeWebhookData`). All Phase 3 deliverers MUST call this before outbound HTTP.
- `validateAndFetch(url, options)` — wrapper that enforces `redirect: "error"`, `validateExternalUrl()`, and `createPinnedDispatcher()`. Phase 3 deliverers MUST NOT call raw `fetch()` directly.
- `BLOCKED_CIDR_REPRESENTATIVES` — array mapping each CIDR to test representative IPv4/IPv6 addresses. Exported for test consumption.
- `sanitizeErrorForStorage(error)` — strips URL query parameters, credential patterns (`token=`, `key=`, `Bearer `) from error messages before storage in `lastError` columns.

This eliminates the R1 risk (reimplementation of SSRF defense) and is a prerequisite for Phase 3.

#### 3.2 New tables: delivery target config + per-target delivery state

```prisma
enum AuditDeliveryTargetKind {
  DB
  WEBHOOK
  SIEM_HEC      // Splunk / Datadog HEC HTTP endpoint
  S3_OBJECT     // S3-compatible object storage via SigV4 REST PUT (AWS S3, GCS interop, R2, MinIO)
}

model AuditDeliveryTarget {
  id        String                  @id @default(uuid(4)) @db.Uuid
  tenantId  String                  @map("tenant_id") @db.Uuid
  kind      AuditDeliveryTargetKind
  // P3-F7 fix: Use String (not Bytes) to match existing TeamWebhook encryption pattern.
  configEncrypted String  @map("config_encrypted")
  configIv        String  @map("config_iv")
  configAuthTag   String  @map("config_auth_tag")
  masterKeyVersion Int   @map("master_key_version")
  isActive  Boolean @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  failCount Int @default(0) @map("fail_count")
  lastError String? @map("last_error") @db.VarChar(1024)
  lastDeliveredAt DateTime? @map("last_delivered_at")

  // Cascade: tenant config rows belong to the tenant lifecycle, like TeamWebhook.
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  deliveries AuditDelivery[]

  @@index([tenantId, isActive])
  @@map("audit_delivery_targets")
}

// P3-F1 fix: Add PROCESSING state for stuck-detection (mirrors AuditOutboxStatus pattern).
enum AuditDeliveryStatus {
  PENDING
  PROCESSING
  SENT
  FAILED
}

model AuditDelivery {
  id              String              @id @default(uuid(4)) @db.Uuid
  outboxId        String              @map("outbox_id") @db.Uuid
  targetId        String              @map("target_id") @db.Uuid
  // P3-S3 fix: Denormalized tenantId for RLS policy (populated from outbox row at insert time).
  tenantId        String              @map("tenant_id") @db.Uuid
  status          AuditDeliveryStatus @default(PENDING)
  attemptCount    Int                 @default(0) @map("attempt_count")
  // P3-F4 fix: Add maxAttempts for dead-letter boundary (matches outbox pattern).
  maxAttempts     Int                 @default(8) @map("max_attempts")
  nextRetryAt     DateTime            @default(now()) @map("next_retry_at")
  // P3-F1 fix: Track processing start for stuck-row reaper.
  processingStartedAt DateTime?       @map("processing_started_at")
  lastError       String?             @map("last_error") @db.VarChar(1024)
  createdAt       DateTime            @default(now()) @map("created_at")

  // P3-F2 fix: Restrict (not Cascade) — delivery rows must not be destroyed
  // by outbox retention purge while deliveries are still pending/processing.
  outbox AuditOutbox        @relation(fields: [outboxId], references: [id], onDelete: Restrict)
  // P3-F5 fix: Restrict — target deletion blocked while delivery rows exist.
  // Targets should be soft-deleted (isActive = false) instead of hard-deleted.
  target AuditDeliveryTarget @relation(fields: [targetId], references: [id], onDelete: Restrict)
  tenant Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@unique([outboxId, targetId])  // dedup
  // P3-F8 fix: Include tenantId in index for tenant-scoped worker queries.
  @@index([tenantId, status, nextRetryAt])
  @@index([status, nextRetryAt])
  @@map("audit_deliveries")
}
```

The DB target ("write to audit_logs") is special-cased and does NOT need an `audit_delivery_targets` row — it's the always-on first target. `audit_deliveries` rows are only created for kinds `WEBHOOK`, `SIEM_HEC`, `S3_OBJECT`.

**S3 fix — RLS on Phase 3 tables**: both `audit_delivery_targets` and `audit_deliveries` MUST have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `tenant_isolation` policies in the Phase 3 migration. `audit_delivery_targets` has a `tenantId` column so the policy mirrors `audit_outbox_tenant_isolation`. `audit_deliveries` has a denormalized `tenantId` column (see schema above) for the same cheap RLS policy.

**S4 fix — Phase 3 worker grants**: the Phase 3 migration must add:
```sql
GRANT SELECT ON TABLE "audit_delivery_targets" TO passwd_outbox_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "audit_deliveries" TO passwd_outbox_worker;
```
DELETE is needed for delivery-row purge. **P3-T5 fix**: Integration test `audit-outbox-worker-role.integration.test.ts` must be **created** (not updated — the file does not exist yet) to assert all Phase 1+2+3 grants in a single test.

**P3-S4 fix — RLS bypass scope**: the delivery fan-out and second delivery loop in the worker MUST run within the same `setBypassRlsGucs()` scope as the existing outbox processing path. Document this in step 22.

**P3-F6 fix — Prisma back-relations**: step 20 must also add:
- `deliveries AuditDelivery[]` on `AuditOutbox` model
- `auditDeliveryTargets AuditDeliveryTarget[]` on `Tenant` model
- `auditDeliveries AuditDelivery[]` on `Tenant` model

#### 3.3 Worker fan-out logic

After the worker successfully writes the row to `audit_logs` (the DB target), it queries `AuditDeliveryTarget where tenantId = X and isActive = true`. For each, it inserts an `audit_deliveries` row. A second worker loop (or the same worker, separate phase) processes pending `audit_deliveries` rows with the same `FOR UPDATE SKIP LOCKED` pattern, calling target-specific deliver functions:

```ts
type DeliverFn = (config: TargetConfig, payload: AuditOutboxPayload) => Promise<void>;

const DELIVERERS: Record<Exclude<AuditDeliveryTargetKind, "DB">, DeliverFn> = {
  WEBHOOK:   deliverWebhook,   // reuses existing dispatcher path
  SIEM_HEC:  deliverSiemHec,   // POST JSON to HEC URL with token
  S3_OBJECT: deliverS3Object,  // PUT JSON to S3 (signed URL or AWS SDK)
};
```

All three delivery functions use `validateAndFetch()` from `external-http.ts` (TM3), which enforces `redirect: "error"` (P3-S6 fix), SSRF validation, and DNS pinning internally. **Do NOT use vendor SDKs** (`@aws-sdk/client-s3`, Splunk SDK, etc.) for user-provided endpoints — they perform their own DNS resolution, bypassing the SSRF pinning defense (S5 fix). **Do NOT call raw `fetch()` directly** — always go through `validateAndFetch()`.

**P3-S2 fix — S3 SigV4 requirements**:
- Build and sign PUT requests manually using SigV4 with the validated URL
- MUST use `x-amz-content-sha256` with actual payload SHA-256 hash (prohibit `UNSIGNED-PAYLOAD`)
- MUST use `Authorization` header signing (NOT presigned URL — presigned URLs leak credentials in `lastError`)
- Validate implementation against AWS official SigV4 test vectors
- Recommend AWS STS AssumeRole + ephemeral tokens over long-lived Access Key + Secret Key (P3-S7 note)

For SIEM HEC: raw POST with the HEC auth token via `Authorization: Splunk <token>` header (NOT query parameter).

**P3-S5 fix — `lastError` sanitization**: all deliverers MUST pass error messages through `sanitizeErrorForStorage()` from `external-http.ts` before writing to `lastError` columns. This strips URL query parameters and credential patterns.

**P3-S1 fix — AAD for `configEncrypted`**: `encryptServerData` / `decryptServerData` calls for `AuditDeliveryTarget.configEncrypted` MUST pass AAD = `Buffer.concat([Buffer.from(targetId), Buffer.from(tenantId)])`. This binds the ciphertext to the specific target + tenant, preventing cross-tenant config transplant.

Document in `external-http.ts`: "Any HTTP client that performs its own DNS resolution bypasses this module's SSRF defense."

#### 3.4 Per-target failure isolation

A target's `audit_deliveries` rows fail independently. The outbox row (`audit_outbox.status`) remains `SENT` once the DB target succeeds — fan-out failures do NOT roll back the audit_logs row. This is the "DB writes still succeed when SIEM is down" property.

**P3-F1 fix — Stuck delivery reaper**: the worker's reaper loop (Phase 2 `reapStuckRows`) is extended to also reset `PROCESSING` delivery rows whose `processingStartedAt < now() - PROCESSING_TIMEOUT_MS` back to `PENDING` (incrementing `attemptCount`). Delivery rows that exceed `maxAttempts` transition to `FAILED`. The reaper emits `AUDIT_DELIVERY_DEAD_LETTER` meta-event via `writeDirectAuditLog()` (bypasses outbox).

**P3-F2 fix — Retention purge and delivery lifecycle**: `purgeRetention()` must NOT delete an outbox row if it has any `audit_deliveries` rows in `PENDING` or `PROCESSING` status. Extended purge query: `WHERE status = 'SENT' AND sent_at < retention_cutoff AND NOT EXISTS (SELECT 1 FROM audit_deliveries WHERE outbox_id = audit_outbox.id AND status IN ('PENDING', 'PROCESSING'))`. Delivery rows in terminal states (`SENT`, `FAILED`) with their own retention are purged by a separate `purgeDeliveryRetention()` step (same retention windows as outbox: 24h for SENT, 90d for FAILED).

**P3-F5 fix — Target soft-delete only**: `AuditDeliveryTarget` deletion is soft-delete only (`isActive = false`). Hard delete is blocked by `onDelete: Restrict` on `AuditDelivery.targetId`. Phase 3.5 CRUD endpoints must enforce this.

**P3-F9-A fix — Delivery failure meta-events**: Phase 3 adds two new audit actions:
- `AUDIT_DELIVERY_FAILED` — emitted when a delivery row transitions to `FAILED` (dead-letter)
- `AUDIT_DELIVERY_DEAD_LETTER` — emitted by the reaper when a stuck delivery row exceeds `maxAttempts`

Both actions are added to `OUTBOX_BYPASS_AUDIT_ACTIONS` (written directly to `audit_logs` by the worker, bypassing outbox) AND `WEBHOOK_DISPATCH_SUPPRESS` (no external webhook dispatch). This prevents R13 re-entrant loops. Constants, i18n labels, and `AUDIT_ACTION_GROUP.MAINTENANCE` membership must be updated.

#### 3.5 Tenant config CRUD endpoints (out of scope for Phase 3 review iteration)

`POST /api/tenant/audit-delivery-targets`, `GET`, `DELETE`. Pattern follows existing `/api/tenant/webhooks` endpoints. Documented as a follow-up; the worker fan-out logic is the load-bearing part of Phase 3.

### Phase 4 — Tamper-evidence (optional, behind tenant flag)

#### 4.1 Schema additions

New table `audit_chain_anchor` (one row per tenant, holds the latest sequence number and prev_hash):

```prisma
model AuditChainAnchor {
  tenantId  String   @id @map("tenant_id") @db.Uuid
  chainSeq  BigInt   @default(0) @map("chain_seq")
  prevHash  Bytes    @default(dbgenerated("'\\x00'::bytea")) @map("prev_hash")
  updatedAt DateTime @updatedAt @map("updated_at")

  // Restrict — mirrors AuditLog (schema.prisma:938). Tenant deletion is already
  // blocked by audit_logs; the anchor is part of the same audit boundary.
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  @@map("audit_chain_anchors")
}
```

**P4-S1 fix (RLS policy — both USING and WITH CHECK)**:
```sql
ALTER TABLE "audit_chain_anchors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_chain_anchors" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_chain_anchors_tenant_isolation ON "audit_chain_anchors"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
    OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
  );
```

**P4-F3 fix (worker grants)**:
```sql
GRANT SELECT, INSERT, UPDATE ON TABLE "audit_chain_anchors" TO passwd_outbox_worker;
```

`AuditLog` gains optional columns:

```prisma
model AuditLog {
  ...
  chainSeq  BigInt? @map("chain_seq")
  eventHash Bytes?  @map("event_hash")
  prevHash  Bytes?  @map("prev_hash")
  ...
}
```

`Tenant` gains:
- `auditChainEnabled Boolean @default(false) @map("audit_chain_enabled")`
- `auditChainAnchor AuditChainAnchor?` (back-relation)

`enum AuditAction` gains: `AUDIT_CHAIN_VERIFY` **(P4-F2 fix — R12 compliance; requires corresponding updates to constants, i18n, and group maps in Step 26)**.

#### 4.2 Single-writer-per-tenant chain computation

When the worker is about to insert an audit row for a tenant that has `auditChainEnabled = true`:

**P4-R2-F3 fix (flag read location)**: Before entering the chain transaction, the worker reads `tenant.auditChainEnabled` via `SELECT audit_chain_enabled FROM tenants WHERE id = $1` (within `setBypassRlsGucs` scope but **outside** the chain transaction to avoid extending lock hold time). If `false`, the worker uses the existing non-chain `deliverRow` path.

```sql
BEGIN;
SET LOCAL lock_timeout = '5000ms';  -- P4-S2 fix: prevent indefinite lock wait
-- P4-F4 fix: ensure anchor row exists (idempotent upsert)
INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash)
  VALUES ($1, 0, '\x00'::bytea)
  ON CONFLICT (tenant_id) DO NOTHING;
SELECT chain_seq, prev_hash FROM audit_chain_anchors WHERE tenant_id = $1 FOR UPDATE;
-- compute event_hash = SHA256(prev_hash || canonical(payload))
-- compute new_seq = chain_seq + 1
-- P4-F1 fix: check INSERT result to prevent chain gap on reprocessing
INSERT INTO audit_logs (..., chain_seq, prev_hash, event_hash, ...)
  VALUES (..., new_seq, prev_hash, event_hash, ...)
  ON CONFLICT (outbox_id) DO NOTHING
  RETURNING id;
-- Only advance anchor if INSERT actually inserted a row (P4-R2-F2 fix: also update outbox status)
IF inserted THEN
  UPDATE audit_chain_anchors SET chain_seq = new_seq, prev_hash = event_hash, updated_at = now() WHERE tenant_id = $1;
END IF;
-- Unconditionally mark outbox row as SENT (regardless of INSERT result)
UPDATE audit_outbox SET status = 'SENT', sent_at = now(), processing_started_at = NULL WHERE id = $outbox_id;
COMMIT;
```

The `FOR UPDATE` on the anchor row serializes chain insertion **per tenant**. Different tenants' chains insert in parallel. This addresses TM2/TM5/P2-S4. Lock acquisition failure (timeout after 5s) is treated as a transient error and retried via normal backoff. `lock_timeout` also applies to the anchor upsert INSERT, but contention on INSERT is negligible (<1ms) in practice.

Canonicalization function: stable JCS (RFC 8785) over `payload_json` plus the row's `id`, **`created_at` (from the outbox row — business-event time, not worker time)**, `chain_seq`, and `prev_hash`. New helper [`src/lib/audit-chain.ts`](../../src/lib/audit-chain.ts). **Exported API**: `computeCanonicalBytes(input)`, `computeEventHash(prevHash, canonicalBytes)`, `buildChainInput(fields)`.

**P4-S5 fix (canonicalization precision)**: `chain_seq` (BigInt) is serialized as a string (`"12345"`) in the canonical input object — avoids IEEE 754 precision loss for values > 2^53. `created_at` is normalized to UTC ISO 8601 with `Z` suffix before inclusion.

**P4-R2-F4/S3 fix (genesis prev_hash)**: The genesis `prev_hash` is `'\x00'::bytea` — a **single zero byte** (not 32-byte zero buffer). This is intentional; normal `prev_hash` values are 32-byte SHA-256 outputs. The unit test must use a 1-byte `Buffer.from([0x00])` for the genesis vector.

**S13/S19 — chain ordering limitation (documented explicitly)**: `chain_seq` represents **ingestion order** (order of worker processing), NOT strict temporal order of the underlying business events. A compromised worker can reorder events within a claim batch and produce a valid, self-consistent chain. The chain only detects **post-insertion tampering** (modifying a row after the hash was computed), NOT pre-insertion reordering by the chain authority (the worker). The verify endpoint additionally checks `created_at` monotonic non-decreasing ordering alongside `chain_seq` — a violation indicates either worker compromise or a bug.

**P4-F6 fix (chain-external rows)**: `writeDirectAuditLog` rows (SYSTEM-actor meta-events like `AUDIT_OUTBOX_REAPED`) have `chain_seq = NULL` and are outside the hash chain scope. The verify endpoint filters these with `WHERE chain_seq IS NOT NULL`.

A new admin endpoint `GET /api/maintenance/audit-chain-verify?tenantId=...&from=...&to=...` re-walks the chain to detect tampering. **S32 fix**: follows the standard admin envelope — `verifyAdminToken`, `createRateLimiter(windowMs: 60_000, max: 3)`, operator membership check, Zod validation on query params (`tenantId: z.string().uuid()`, `from: z.coerce.date().min(fiveYearsAgo).optional()`, `to: z.coerce.date().max(now).optional()`, plus `from < to` logic check — P4-S4 fix), result pagination capped at 10,000 rows per request to prevent DoS. **P4-F5 fix**: at request start, capture `anchor.chain_seq` as the upper bound; scan only `chain_seq <= captured_max`. **P4-S3 fix**: response shape `{ ok, firstTamperedSeq?, firstGapAfterSeq?, totalVerified }` — no raw hashes exposed. **P4-T7 fix**: verify also checks `chain_seq` dense monotonic (no gaps).

**P4-R2-F1 fix (from/to semantics)**: `from/to` filter by `created_at` to determine the `chain_seq` range to verify. When `from` is provided, the endpoint finds the lowest `chain_seq` where `created_at >= from` and loads the `event_hash` from `chain_seq - 1` as the genesis hash for the partial walk. When only `from` is provided (no `to`), `to` defaults to the anchor snapshot time. This enables partial-chain verification without scanning from `chain_seq = 1`. When neither `from` nor `to` is provided, the endpoint walks from `chain_seq = 1` to `captured_max`.

**P4-R2-N2 fix (empty chain)**: If the anchor row does not exist (tenant has `auditChainEnabled = true` but no events processed yet), the endpoint returns `{ ok: true, totalVerified: 0 }` — not an error.

**P4-R2-S4 fix (logAudit usage)**: The verify endpoint uses `logAudit()` (fire-and-forget void, NOT `logAuditInTx`) to record the verification event. This ensures the verify event is enqueued after the snapshot is captured, preventing it from appearing in the current scan. **Do not migrate to `logAuditInTx`** — the verify event would then be inside the scan transaction scope and interfere with the snapshot boundary.

#### 4.3 External notarization (out of scope for plan, noted)

Optional periodic export of the latest `prev_hash` to a timestamping authority (RFC 3161). Documented as a follow-up; not designed in this plan.

### Worker invocation model summary

| Environment | How |
|---|---|
| Local dev (npm) | `npm run worker:audit-outbox` (tsx + `OUTBOX_WORKER_DATABASE_URL` env) |
| Local dev (docker) | `audit-outbox-worker` service in `docker-compose.override.yml` (depends_on `migrate`, `db`) |
| Production (k8s) | `Deployment` with replicas=1, separate image tag `audit-outbox-worker`, mounts secret with role password |
| Production (single VM) | systemd unit (sample provided in `docs/operations/audit-outbox-worker.md`) |

Multiple replicas are safe by design (TM7 + `FOR UPDATE SKIP LOCKED`); production starts at 1 to avoid premature scaling.

## Implementation steps (numbered)

### Phase 1
1. Add `enum AuditOutboxStatus` and `model AuditOutbox` to `prisma/schema.prisma`. Add `outboxId String? @unique` to `AuditLog`. Add relation back-ref on `Tenant`.
2. Generate migration `<ts>_add_audit_outbox`. Add raw SQL for `ENABLE / FORCE ROW LEVEL SECURITY` and the policy. Add the unique index on `audit_logs.outbox_id`.
3. Generate migration `<ts>_add_audit_outbox_worker_role` with `CREATE ROLE` (idempotent), grants, and the parallel update to `infra/postgres/initdb/02-create-app-role.sql`. **The role MUST be created with `PASSWORD NULL` and the application's deployment script (or `psql \getenv PASSWD_OUTBOX_WORKER_PASSWORD` in initdb) sets the password from an env var, identical to the `passwd_app` pattern at [`infra/postgres/initdb/02-create-app-role.sql:8,16-19`](../../infra/postgres/initdb/02-create-app-role.sql). No literal password in the migration SQL.**
4. Run `npm run db:migrate` against the dev DB and verify `passwd_app` cannot bypass the new RLS.
5. Create `src/lib/audit-outbox.ts` with `enqueueAuditInTx()` and `enqueueAudit()`.
6. Rewrite `src/lib/audit.ts` `logAudit()` and `logAuditBatch()`:
   - Remove the in-line DB write + webhook dispatch.
   - Add a tiny pre-outbox emergency buffer (`enqueuePreOutbox` / `drainPreOutbox`, max 50 entries) used ONLY when `enqueueAudit` itself throws (DB completely unreachable).
   - Add a new `logAuditInTx(tx, params)` exported function for callers already in a transaction.
   - Keep `logAudit` and `logAuditBatch` signatures unchanged.
7. Create `src/workers/audit-outbox-worker.ts` (the loop body) and `scripts/audit-outbox-worker.ts` (the entrypoint).
8. Add `npm run worker:audit-outbox` script to `package.json`.
9. Add `audit-outbox-worker` service to `docker-compose.yml` and `docker-compose.override.yml`. Provide `OUTBOX_WORKER_DATABASE_URL` env.
10. Tests for Phase 1 (see Testing strategy below).

### Phase 2
11. Add 4 new audit actions to `enum AuditAction` via two migrations (PG ≤11 limitation noted in existing migration's comment is informational; PG 16 is fine, but use one ALTER per migration if a single-statement-per-migration convention is preferred — verify against the current convention).
12. Update `src/lib/constants/audit.ts` (`AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUP.MAINTENANCE`, `AUDIT_ACTION_GROUPS_TENANT`, `TENANT_WEBHOOK_EVENT_GROUPS` exclusion).
13. Update `messages/en/AuditLog.json` and `messages/ja/AuditLog.json`.
14. Add tests asserting full coverage of `AUDIT_ACTION_VALUES` across groups and i18n labels (R12).
15. Implement reaper in `audit-outbox-worker.ts` with the SQL from §2.2. Add `OUTBOX_BYPASS_AUDIT_ACTIONS` set used by the worker for direct `audit_logs` writes.
16. Implement metrics endpoint at `/api/maintenance/audit-outbox-metrics`.
17. Extend `src/lib/health.ts` readiness check with the threshold logic.
18. Delete `src/lib/audit-retry.ts` and `src/lib/audit-retry.test.ts`. Remove all imports. Remove pre-outbox emergency buffer from `src/lib/audit.ts`.

### Phase 3
19. Extract SSRF helpers + sanitization from `src/lib/webhook-dispatcher.ts` to new `src/lib/external-http.ts`. Include: `BLOCKED_CIDRS`, `BLOCKED_CIDR_REPRESENTATIVES` (P3-T2), `isPrivateIp`, `resolveAndValidateIps`, `createPinnedDispatcher`, `validateAndFetch` (wrapper enforcing `redirect: "error"`, P3-S6), `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` (renamed from `WEBHOOK_METADATA_BLOCKLIST` + PII keys, P3-F3), `sanitizeForExternalDelivery`, `sanitizeErrorForStorage` (P3-S5). Re-export from `webhook-dispatcher.ts` to preserve internal use sites. Add unit tests — `BLOCKED_CIDRS` MUST be exported (P3-T1 done-criteria).
20. Add `enum AuditDeliveryTargetKind`, `enum AuditDeliveryStatus` (with `PROCESSING`, P3-F1), models `AuditDeliveryTarget` (String encryption fields, P3-F7), `AuditDelivery` (with denormalized `tenantId` P3-S3, `maxAttempts` P3-F4, `processingStartedAt` P3-F1, `onDelete: Restrict` FKs P3-F2/F5) to schema. Add back-relations: `deliveries AuditDelivery[]` on `AuditOutbox`, `auditDeliveryTargets AuditDeliveryTarget[]` + `auditDeliveries AuditDelivery[]` on `Tenant` (P3-F6). Migration `<ts>_add_audit_delivery_targets` with RLS + FORCE RLS + tenant_isolation policies on both tables. Worker grants (P3-S4). Add 2 new audit actions: `AUDIT_DELIVERY_FAILED`, `AUDIT_DELIVERY_DEAD_LETTER` to `enum AuditAction`, constants, i18n, bypass sets, suppress sets (P3-F9-A). **Create** (not update) `audit-outbox-worker-role.integration.test.ts` asserting all Phase 1+2+3 grants (P3-T5).
21. Implement `deliverWebhook`, `deliverSiemHec`, `deliverS3Object` in `src/workers/audit-delivery.ts`. All three call `validateAndFetch()` (NOT raw `fetch`). S3 SigV4: `Authorization` header with actual payload hash (P3-S2). SIEM HEC: `Authorization: Splunk <token>` header. `configEncrypted` decryption MUST pass AAD (P3-S1). `lastError` writes MUST use `sanitizeErrorForStorage()` (P3-S5). Payload sanitized with `sanitizeForExternalDelivery()` before outbound HTTP.
22. Extend the worker loop with a second pass: after marking an outbox row `SENT`, query active targets for the tenant and create `audit_deliveries` rows. A second loop processes those rows with `FOR UPDATE SKIP LOCKED`. Delivery fan-out and second loop MUST run within `setBypassRlsGucs()` scope (P3-S4). Extend reaper to reset stuck `PROCESSING` delivery rows and dead-letter exceeded `maxAttempts` rows (P3-F1). Extend `purgeRetention()` to skip outbox rows with pending deliveries (P3-F2). Add `purgeDeliveryRetention()` for terminal delivery rows.
23. Tests: deliverer unit tests per deliverer (P3-T6: `audit-deliverer-webhook.test.ts`, `audit-deliverer-siem-hec.test.ts`, `audit-deliverer-s3-object.test.ts`), SSRF rejection with guard assertion (P3-T1), per-target failure isolation, fan-out integration test. Rate limiter API defined: per-target `window_ms` and `max` using `createRateLimiter` pattern, excess deliveries remain `PENDING` with future `nextRetryAt` (P3-T4). Test key count assertions use imported `EXTERNAL_DELIVERY_METADATA_BLOCKLIST.size` (P3-T3).
24. (Out of scope for the loaded review, but listed for completeness): tenant CRUD endpoints for `audit_delivery_targets`. Note: targets support soft-delete only (`isActive = false`, P3-F5).

### Phase 4
25. Add `model AuditChainAnchor`, columns on `AuditLog`, flag on `Tenant`, back-relation `auditChainAnchor AuditChainAnchor?` on `Tenant`. Add `AUDIT_CHAIN_VERIFY` to `enum AuditAction` in `prisma/schema.prisma`. Migration `<ts>_add_audit_chain`:
    - `ENABLE / FORCE ROW LEVEL SECURITY` on `audit_chain_anchors`
    - **P4-S1 fix**: `audit_chain_anchors_tenant_isolation` policy with **both USING and WITH CHECK** (same pattern as `audit_outbox_tenant_isolation`)
    - **P4-F3 fix**: `GRANT SELECT, INSERT, UPDATE ON TABLE "audit_chain_anchors" TO passwd_outbox_worker` (INSERT for anchor upsert, SELECT+UPDATE for chain computation)
    - Install `canonicalize` npm package: `npm install canonicalize` (JCS RFC 8785 implementation)
26. Update `src/lib/constants/audit.ts`: add `AUDIT_CHAIN_VERIFY` to `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_TENANT[MAINTENANCE]`, `WEBHOOK_DISPATCH_SUPPRESS`. Update `messages/en/AuditLog.json` and `messages/ja/AuditLog.json` with translation key. **(P4-F2 fix — R12 compliance)**
27. Implement `src/lib/audit-chain.ts`:
    - **Exported functions**: `computeCanonicalBytes(input)`, `computeEventHash(prevHash, canonicalBytes)`, `buildChainInput(fields)` — all named exports for testability **(P4-T9 fix)**
    - JCS canonicalization via `canonicalize` package (RFC 8785)
    - **P4-S5 fix**: `chain_seq` (BigInt) serialized as string (`"12345"`) in canonical form. `created_at` normalized to UTC ISO 8601 with `Z` suffix before canonicalization
28. Worker integration: when `tenant.auditChainEnabled`, the worker uses the chain insertion path:
    - **P4-F4 fix (anchor initialization)**: Before `SELECT FOR UPDATE`, execute `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash) VALUES ($1, 0, '\x00') ON CONFLICT (tenant_id) DO NOTHING` to ensure anchor exists
    - **P4-S2 fix (lock timeout)**: Set `SET LOCAL lock_timeout = '5000ms'` within the chain insertion transaction. Lock acquisition failure is treated as transient error (normal backoff retry)
    - **P4-F1 fix (reprocessing safety)**: Use `INSERT INTO audit_logs (...) ... ON CONFLICT (outbox_id) DO NOTHING RETURNING id`. If RETURNING is empty (conflict = already delivered), skip anchor UPDATE and commit without chain advancement. This prevents chain_seq gaps on reaper-triggered reprocessing
    - Single transaction: `BEGIN → UPSERT anchor → SELECT FOR UPDATE anchor → compute hash → INSERT audit_log (RETURNING id) → conditional anchor UPDATE → COMMIT`
29. Implement `GET /api/maintenance/audit-chain-verify` admin endpoint:
    - Standard admin envelope: `verifyAdminToken`, `createRateLimiter(windowMs: 60_000, max: 3)`, operator membership check
    - Zod validation: `tenantId: z.string().uuid()`, `from: z.coerce.date().min(fiveYearsAgo).optional()`, `to: z.coerce.date().max(new Date()).optional()`, plus `from < to` logic validation **(P4-S4 fix)**
    - **P4-F5 fix (snapshot consistency)**: At request start, capture `anchor.chain_seq` as upper bound. Scan only `WHERE chain_seq IS NOT NULL AND chain_seq <= captured_max ORDER BY chain_seq` **(P4-F6 fix — filters out writeDirectAuditLog rows)**
    - Pagination capped at 10,000 rows per request
    - Chain walk: re-compute each hash, verify `chain_seq` monotonic dense (no gaps — **P4-T7 fix**), verify `created_at` non-decreasing
    - **P4-S3 fix (minimal response)**: Response shape `{ ok: boolean, firstTamperedSeq?: number, firstGapAfterSeq?: number, totalVerified: number }` — no raw hashes exposed
    - Emit `logAudit(AUDIT_CHAIN_VERIFY)` after verification
30. Tests (see Phase 4 tests below). **P4-T1 fix (prerequisite)**: Before Phase 4 tests, ensure `vitest.integration.config.ts` has `poolOptions: { forks: { singleFork: true } }` and `audit-outbox-integration` CI job exists in `.github/workflows/ci.yml`.

## Testing strategy

The most important property — **business write succeeds ⇔ audit row exists in outbox** — cannot be verified with mocks (P2-T1, R5, project memory `project_integration_test_gap`). The plan therefore introduces real-Postgres integration tests as a deliberate, scoped addition.

### Test infrastructure addition (revised per T2, T4)

**File naming convention**: all real-DB tests MUST end in `.integration.test.ts`. All real-DB tests live under `src/__tests__/db-integration/` (a NEW directory, separate from the existing mocked `src/__tests__/integration/`).

**Vitest config changes (T4 fix)**:
1. Amend existing `vitest.config.ts`: add `exclude: ["src/**/*.integration.test.ts"]` to prevent real-DB tests from running in the unit test job (which has no Postgres).
2. Create `vitest.integration.config.ts` with `include: ["src/**/*.integration.test.ts"]`.
3. Add `"test:integration": "vitest run --config vitest.integration.config.ts"` to `package.json`.

**CI integration (T2 fix)**: align with the existing `rls-smoke` job pattern (`.github/workflows/ci.yml:292-346`) — a GitHub Actions `postgres:16-alpine` service (NOT docker-compose). The new `audit-outbox-integration` job:
1. Declares `services: postgres: image: postgres:16-alpine` with env vars.
2. Runs `psql` to create `passwd_app` and `passwd_outbox_worker` roles.
3. Runs `npx prisma migrate deploy`.
4. Runs `npx vitest --config vitest.integration.config.ts`.

**Local dev**: `docker compose up -d db` (port published via `docker-compose.override.yml`) + `npm run db:migrate` + `npm run test:integration`.

**Test isolation (T20 fix)**: each integration test generates unique tenant UUID via `crypto.randomUUID()` in `beforeEach`. `afterEach` cascade-deletes test data in FK-safe order. `vitest.integration.config.ts` uses `pool: 'forks'` + `poolOptions.forks.singleFork: true` (serial execution; real-DB tests should not run in parallel within a single vitest process).

### Phase 1 tests

| Test | DB/Mock | What it verifies |
|---|---|---|
| `audit-outbox-atomicity.integration.test.ts` | Real DB | (a) `logAuditInTx` inside `prisma.$transaction(tx => { ...; throw })` → both business + outbox rows roll back. (b) Successful tx → exactly one `PENDING` outbox row. (P2-T1) |
| `audit-logaudit-non-atomic.integration.test.ts` | Real DB | **(T1 fix — negative test)**: `logAudit` (void shim) called inside `prisma.$transaction(... throw)` → audit entry IS still enqueued to FIFO (proving non-atomicity). This test documents the known limitation and prevents future developers from assuming `logAudit` is atomic. |
| `audit-outbox-state-machine.integration.test.ts` | Real DB | `pending → processing → sent` happy path; `pending → processing → pending (retry)` on failure; `pending → ... → failed (dead-letter)` after `AUDIT_OUTBOX.MAX_ATTEMPTS` (imported, T18/RT3). (P2-T2) |
| `audit-outbox-skip-locked.integration.test.ts` | Real DB | Two concurrent workers claim disjoint row sets. **Implementation (T5 fix)**: create TWO Prisma clients with separate `pg.Pool`s both connecting as `passwd_outbox_worker`; use explicit `$executeRawUnsafe("BEGIN")` + `SELECT FOR UPDATE SKIP LOCKED` via `Promise.all` with a Deferred barrier. |
| `audit-outbox-rls.integration.test.ts` | Real DB | (a) `passwd_app` without bypass GUC → cannot SELECT cross-tenant outbox rows. (b) **FORCE RLS check (T7 fix)**: `passwd_user` (table owner) WITHOUT bypass GUC → also cannot SELECT cross-tenant rows (proves FORCE is set, not just ENABLE). |
| `audit-outbox-worker-role.integration.test.ts` | Real DB | **Privilege enumeration (T8 fix)**: query `information_schema.table_privileges WHERE grantee = 'passwd_outbox_worker'` and assert the EXACT allowed set (`SELECT,UPDATE,DELETE on audit_outbox; INSERT on audit_logs; SELECT on tenants`). Any unexpected grant fails the test. Also asserts: cannot `SELECT users`, cannot `INSERT passwords`, cannot `nextval()` on any sequence. |
| `audit-outbox-dedup.integration.test.ts` | Real DB | **(T9 fix)**: tests 3 cases: (a) new row → INSERT succeeds + SENT, (b) pre-existing row with same `outboxId` → `ON CONFLICT DO NOTHING` + SENT (not FAILED), (c) different `outboxId` → normal insert. |
| `audit-outbox-reentrant-guard.integration.test.ts` | Real DB | **(T10/S16 fix — R13 in Phase 1)**: mock deliverer that throws; enqueue business row; assert resulting failure audit event is written directly to `audit_logs` (not as new outbox row); assert worker returns to idle within 2 s. |
| `audit.mocked.test.ts` (renamed from `audit.test.ts`) | Mocked | **(T3 fix)**: narrowed to pure-function coverage: `sanitizeMetadata`, `extractRequestMeta`, `resolveActorType`, `truncateMetadata`. Does NOT assert outbox row shape (that's the real-DB test's job). |
| `audit-fifo-flusher.test.ts` | Mocked | **(T6 fix)**: uses `vi.useFakeTimers()` + advance by `OUTBOX_FLUSH_INTERVAL_MS`; tests `process.emit('beforeExit')` fires flush; tests concurrent `logAudit` during in-flight flush; tests dead-letter after 3 failures; tests SIGTERM handler drains queue then exits (T28 fix — verifies 5 s timeout forces `process.exit()`); tests AsyncLocalStorage isolation (`tenantRlsStorage.run(undefined, ...)` is called); **(T27 fix)**: tests per-entry failure isolation — one entry's tenantId resolution failure dead-letters that entry without blocking the batch. |

### Phase 2 tests

| Test | DB/Mock | What it verifies |
|---|---|---|
| Extend `src/lib/constants/audit.test.ts` (T11 fix — no new file) | Mocked | (a) Every entry in `AUDIT_ACTION_VALUES` appears in at least one of `_PERSONAL` / `_TEAM` / `_TENANT` groups. (b) **(F24 fix — negative assertion)**: MAINTENANCE group actions MUST NOT appear in `_PERSONAL` or `_TEAM` group maps. (R12) |
| `audit-i18n-coverage.test.ts` | Mocked | Every entry in `AUDIT_ACTION_VALUES` has a label in both `en` and `ja` JSON files. **(T29 fix)**: also asserts every `AUDIT_ACTION_GROUP` value (including `groupMaintenance`) has a label in both locale files. |
| `audit-outbox-reaper.integration.test.ts` | Real DB | Row stuck in `processing` for > timeout is reset to `pending` (reaper uses `FOR UPDATE SKIP LOCKED` per T19 fix); `AUDIT_OUTBOX_REAPED` row written directly to `audit_logs`. |
| `audit-outbox-reaper-noninterference.integration.test.ts` | Real DB | **(T19 fix)**: starts worker claim, starts reaper in parallel, asserts reaper does not touch in-flight row. |
| `audit-outbox-retention-purge.integration.test.ts` | Real DB | `sent` rows older than `OUTBOX_RETENTION_HOURS` deleted; `failed` rows older than `OUTBOX_FAILED_RETENTION_DAYS` deleted; `failed` rows newer than threshold NOT deleted; `PROCESSING` and `PENDING` rows NOT deleted regardless of age (T33 fix). |
| `audit-outbox-metrics-endpoint.test.ts` | Mocked | Metrics endpoint requires `verifyAdminToken`, operator membership, returns expected JSON shape. Asserts `mockLogAudit` called with `action: AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW` imported from `@/lib/constants/audit` (T12/RT3 fix). |
| `audit-outbox-metrics-endpoint.integration.test.ts` | Real DB | **(T12 fix)**: does NOT mock `logAudit`; asserts actual `audit_logs` row written with correct action. |
| `audit-outbox-readiness.test.ts` | Mocked | Readiness probe returns 503 when `pending > threshold` AND when `oldestPendingAgeSeconds > threshold` (T26 fix — both conditions tested). |
| `audit-outbox-userId-system.integration.test.ts` | Real DB | Worker-written SYSTEM event has `userId = NULL` and `actorType = SYSTEM`; CHECK constraint rejects `userId = NULL` with non-SYSTEM actorType. (S9 fix) |
| `audit-outbox-before-delete-trigger.integration.test.ts` | Real DB | **(T31 fix)**: connects as `passwd_outbox_worker`; asserts `DELETE WHERE status='PENDING'` raises exception; asserts `DELETE WHERE status='PROCESSING'` raises exception; asserts `DELETE WHERE status='SENT'` succeeds; asserts `DELETE WHERE status='FAILED'` succeeds. Verifies the mandatory `BEFORE DELETE` trigger (TM1 defense). |
| `audit-bypass-coverage.test.ts` | Mocked | **(T21 fix)**: asserts every action whose name starts with `AUDIT_OUTBOX_` is present in `WEBHOOK_DISPATCH_SUPPRESS`; asserts `OUTBOX_BYPASS_AUDIT_ACTIONS` contains exactly the 3 worker-emitted actions (REAPED, DEAD_LETTER, RETENTION_PURGED) AND the 2 Phase 1 initial members (`WEBHOOK_DELIVERY_FAILED`, `TENANT_WEBHOOK_DELIVERY_FAILED`) (T32 fix); asserts it does NOT contain the admin-endpoint actions (METRICS_VIEW, PURGE_EXECUTED). Enforces the R13 suppression checklist. |
| `audit-outbox-null-invariant.integration.test.ts` | Real DB | **(T23 fix)**: only rows with `action IN OUTBOX_BYPASS_AUDIT_ACTIONS` may have `outboxId = NULL` in `audit_logs`. Insert with NULL outboxId + non-bypass action → constraint violation or failing assertion. |
| `audit-outbox-purge-failed-endpoint.test.ts` | Mocked | **(T25 fix)**: purge-failed endpoint requires `verifyAdminToken`, operator membership, Zod validation on body; emits `AUDIT_OUTBOX_PURGE_EXECUTED` via `logAudit`. |
| `audit-outbox-purge-failed-endpoint.integration.test.ts` | Real DB | **(T25 fix)**: purge-failed endpoint deletes only FAILED rows matching criteria; does not delete PENDING/PROCESSING/SENT rows. |

### Phase 3 tests

| Test | DB/Mock | What it verifies |
|---|---|---|
| `external-http-ssrf.test.ts` | Mocked DNS | **(T14 fix)**: `describe.each` iterating ALL entries in `BLOCKED_CIDRS` (imported from `external-http.ts`, RT3) using `BLOCKED_CIDR_REPRESENTATIVES` (P3-T2); asserts both IPv4 and IPv6 representatives rejected; count assertion `>= BLOCKED_CIDRS.length * 2`. **P3-T1 fix**: guard assertion `expect(BLOCKED_CIDRS.length).toBeGreaterThan(0)` at test top to prevent false-positive from empty `describe.each`. After extraction, BOTH `webhook-dispatcher.test.ts` and this new test must pass. |
| `audit-deliverer-webhook.test.ts` | Mocked HTTP | **(P3-T6 fix)**: `deliverWebhook` unit test — verifies HTTP headers, Content-Type, sanitized payload, `validateAndFetch` usage. |
| `audit-deliverer-siem-hec.test.ts` | Mocked HTTP | **(P3-T6 fix)**: `deliverSiemHec` unit test — verifies `Authorization: Splunk <token>` header, Content-Type `application/json`, payload sanitization. |
| `audit-deliverer-s3-object.test.ts` | Mocked HTTP | **(P3-T6 fix)**: `deliverS3Object` unit test — verifies SigV4 `Authorization` header, `x-amz-content-sha256` with actual hash (NOT `UNSIGNED-PAYLOAD`), payload format. Validate against AWS SigV4 test vectors. |
| `audit-delivery-fanout.integration.test.ts` | Real DB | One outbox row → N `audit_deliveries` rows; each fails/succeeds independently. |
| `audit-delivery-failure-isolation.integration.test.ts` | Real DB | SIEM target failure does not block S3 target success. |
| `audit-outbox-worker-fanout.integration.test.ts` | Real DB + Mocked HTTP | **(T17 fix — explicit hybrid annotation)**: Worker calls correct deliverer for each kind, passes payload sanitized with `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` (S2 fix verification). |
| `audit-delivery-rate-limit.integration.test.ts` | Real DB | **(P3-T4 fix — reclassified to integration)**: N > max requests per target within window → excess deliveries remain `PENDING` with future `nextRetryAt`, not dropped. Uses `createRateLimiter` pattern with configurable `window_ms` and `max`. |
| `audit-delivery-rls.integration.test.ts` | Real DB | (S3 fix) Cross-tenant read/write on `audit_delivery_targets` and `audit_deliveries` blocked by RLS. |
| `audit-delivery-pii-sanitization.integration.test.ts` | Real DB + Mocked HTTP | (S2 fix) Event with all blocklisted keys in metadata → none appear in outbound HTTP payload for WEBHOOK/SIEM_HEC/S3_OBJECT targets. **(P3-T3 fix)**: assert count against `EXTERNAL_DELIVERY_METADATA_BLOCKLIST.size` (imported constant), not hardcoded number. |
| `audit-delivery-stuck-reaper.integration.test.ts` | Real DB | **(P3-F1 fix)**: `PROCESSING` delivery rows older than `PROCESSING_TIMEOUT_MS` are reset to `PENDING`; rows exceeding `maxAttempts` transition to `FAILED` and emit `AUDIT_DELIVERY_DEAD_LETTER` meta-event. |
| `audit-delivery-retention-purge.integration.test.ts` | Real DB | **(P3-F2 fix)**: outbox rows with pending deliveries are NOT purged; terminal delivery rows are purged by `purgeDeliveryRetention()`. |
| Create `audit-outbox-worker-role.integration.test.ts` | Real DB | **(P3-T5 fix)**: **New file** — asserts all Phase 1+2+3 grants for `passwd_outbox_worker`: `audit_outbox` (SELECT/UPDATE/DELETE), `audit_logs` (INSERT), `tenants` (SELECT), `audit_delivery_targets` (SELECT), `audit_deliveries` (SELECT/INSERT/UPDATE/DELETE). |

### Phase 4 tests

**P4-T1 fix (prerequisite)**: Before adding Phase 4 tests, ensure `vitest.integration.config.ts` has `poolOptions: { forks: { singleFork: true } }` and `audit-outbox-integration` CI job exists in `.github/workflows/ci.yml` (following existing `rls-smoke` job pattern). This is a prerequisite carried over from Phase 1 design.

| Test | DB/Mock | What it verifies |
|---|---|---|
| `audit-chain.unit.test.ts` | Mocked | **(P4-T3 fix)**: Unit tests for `computeCanonicalBytes`, `computeEventHash`, `buildChainInput` — functions imported as named exports from `@/lib/audit-chain`. Fixed test vectors: known inputs → expected SHA-256 outputs. Covers: initial `prev_hash` (`\x00` — single zero byte, matching schema default; NOT 32-byte zero buffer), normal 32-byte prev_hash, `created_at` timezone normalization (`Z` suffix), `chain_seq` BigInt serialization as string. **(P4-R2-N4 fix — RT3 scope)**: functions are imported from module (not hardcoded strings); test vector expected hashes are legitimately hardcoded fixed values. |
| `audit-chain-ordering.integration.test.ts` | Real DB | **(T13 fix — resolved Q7, P4-T6 fix, P4-R2-N1 fix — barrier placement specified)**: uses same two-Prisma-client + Deferred barrier pattern as `audit-outbox-skip-locked`. **Concurrency sequence**: Client A and Client B both execute `BEGIN; INSERT ... ON CONFLICT (anchor upsert)`. Deferred barrier is placed **immediately before `SELECT ... FOR UPDATE`**. Both clients release the barrier simultaneously via `Promise.all`. Client A acquires the lock first and commits. Client B then acquires the lock and commits. Assert `chain_seq` values are `(1, 2)` with no gaps or duplicates. `created_at` is non-decreasing (S13/S19 fix). |
| `audit-chain-tamper-detection.integration.test.ts` | Real DB | Modifying a row's payload after insertion is detected by the verify endpoint. **(P4-T7 fix, P4-R2-N3 fix — test setup specified)**: gap detection test uses `passwd_user` (SUPERUSER) connection with `setBypassRlsGucs` to directly INSERT `audit_logs` rows with `chain_seq` gap (e.g., seq 1, 2, 4). Verify endpoint reports the gap via `firstGapAfterSeq`. |
| `audit-chain-cross-tenant.integration.test.ts` | Real DB | Two tenants' chains are independent; stuck chain on tenant A does not block tenant B. |
| `audit-chain-disabled.integration.test.ts` | Real DB | **(P4-T4 fix, P4-R2-N5 fix)**: Process outbox row for `auditChainEnabled = false` tenant. Assert resulting `audit_logs` row has `chain_seq IS NULL`, `event_hash IS NULL`, `prev_hash IS NULL`. Also assert `audit_chain_anchors` has **no row** for this tenant (anchor should not be created for disabled tenants). |
| `audit-chain-rls.integration.test.ts` | Real DB | **(P4-T5 fix)**: (a) `passwd_app` without bypass GUC cannot SELECT/UPDATE cross-tenant anchor row. (b) `passwd_user` (table owner) without bypass GUC also cannot (FORCE RLS check). |
| `audit-chain-verify-endpoint.test.ts` | Mocked | **(P4-T2 fix)**: Verify endpoint requires `verifyAdminToken`, operator membership. Zod rejects invalid `tenantId` / `from > to`. Rate limiter `max: 3`. Assert `logAudit` (not `logAuditInTx`) called with `AUDIT_CHAIN_VERIFY` (imported from `@/lib/constants/audit`, RT3). |
| `audit-chain-verify-endpoint.integration.test.ts` | Real DB | **(P4-T2 fix, P4-R2-N2 fix)**: Real DB: valid chain → `{ ok: true, totalVerified: N }`. Tampered chain → `{ ok: false, firstTamperedSeq: N }`. **Empty chain (anchor not yet created)** → `{ ok: true, totalVerified: 0 }`. |
| Update `audit-outbox-worker-role.integration.test.ts` | Real DB | **(P4-T9 merged into F3)**: Add `SELECT, INSERT, UPDATE on audit_chain_anchors` to expected grant set. |

**P4-T10 fix**: Existing `audit-i18n-coverage.test.ts` and `audit-bypass-coverage.test.ts` will automatically fail if `AUDIT_CHAIN_VERIFY` is missing from i18n or bypass sets — no additional test changes needed, but this dependency is documented here for implementer awareness.

### Prior review findings resolution (T16 fix)

- **P2-T3** (existing test fixtures `FULL_POLICY_RESPONSE`, `BASE_POLICY`): no tenant policy schema fields are added by this plan (outbox uses env-configurable constants). No fixture updates needed.
- **P2-T4** (`account-lockout.ts` configurable thresholds): out of scope for this plan. Tracked as a separate follow-up; not silently dropped.

### Recurring issue tests

- R12 enforced by extending `src/lib/constants/audit.test.ts` (above).
- R13 enforced by `audit-outbox-reentrant-guard.integration.test.ts` (Phase 1) — synthetically triggers webhook delivery failure and asserts the resulting meta-event bypasses the outbox.
- R7 (E2E selectors): no UI changes in this plan; metrics endpoint is API-only. N/A check.
- R10 (circular imports): `audit-outbox.ts` does not import `audit.ts`; `audit.ts` continues to lazy-import `webhook-dispatcher`. The new worker file imports `audit-outbox.ts` only. Verified by static import graph.
- RT3: all test assertions use imported constants from `@/lib/constants/audit` — no hardcoded string literals for action names, batch sizes, or thresholds.

## Considerations & constraints

### Out of scope
- UI for managing `audit_delivery_targets` (Phase 3 follow-up).
- Full migration of all 187 `logAudit` call sites to `logAuditInTx(tx, ...)`. Phase 1 only adds the helper; the bulk migration is a separate sweep.
- External notarization (Phase 4 follow-up).
- Vendor lock-in for SIEM: only generic HTTP HEC is supported in Phase 3. Splunk-specific features and Datadog batching are deferred.

### Known constraints
- The fire-and-forget `void`-returning signature of `logAudit` is deliberately preserved to avoid touching 187 call sites. The "atomicity with business" guarantee is therefore strictly available only via the new `logAuditInTx(tx, ...)` helper. **Documenting this clearly is critical** — see Considerations below.
- The existing `logAudit` async closure already calls `withBypassRls` which opens its own `prisma.$transaction`. The new `logAuditInTx` accepts the parent `tx` and writes within that scope; the parent must already be running under `withBypassRls` OR the parent must `set_config('app.bypass_rls', 'on', true)` itself before the call. Document this contract.
- `passwd_app` cannot create `audit_outbox` rows under RLS unless the call goes through `withBypassRls`. Same property as `audit_logs` today.
- The pre-outbox emergency buffer is RAM-only. It exists only for Phase 1; Phase 2 deletes it. Its existence is a known regression vs. the durability goal — but only for the rare case where the DB is **completely unreachable from the request handler**, which is the same case where the current `audit-retry.ts` already drops events.

### Risks
- **R-PHASE1-1**: 187 call sites remain on the void-returning path. If a future change accidentally relies on the parent transaction rolling back when `logAudit` fails, that property is NOT preserved. Mitigation: documented in code comment + lint rule (out of scope: a custom ESLint rule that flags `logAudit` inside `prisma.$transaction` callbacks and recommends `logAuditInTx`).
- **R-PHASE2-1**: Removing `audit-retry.ts` is the kind of subtle delete that breaks production silently. Phased rollout: Phase 2 ships behind a feature flag `AUDIT_OUTBOX_ENABLED=true` with the old path retained until the flag is removed in a subsequent release.
- **R-PHASE3-1**: The fan-out worker can multiply effective request volume to external systems by N (number of targets). Per-target rate limiting required; reuse the existing `createRateLimiter` pattern.
- **R-PHASE4-1**: Hash chain `FOR UPDATE` serializes audit insertion per tenant. For very-high-write tenants this is a bottleneck. Mitigation: hash chain is opt-in per tenant (`auditChainEnabled` flag), default OFF.

## User operation scenarios

These describe the workflows that exercise the system end-to-end, to surface edge cases.

### S1 — Normal audit write (Phase 1)
1. User updates a password entry via `PUT /api/passwords/[id]`.
2. The route handler runs the update inside `prisma.$transaction(tx => { ... })`.
3. After the update, the handler calls `await logAuditInTx(tx, { action: ENTRY_UPDATE, ... })`.
4. Transaction commits. One outbox row is now `PENDING`.
5. Within ≤ 1 s the worker claims the row, inserts into `audit_logs`, marks `SENT`, dispatches webhooks (if any).
6. UI shows the audit event in the audit log view shortly after.

### S2 — Worker is down
1. User performs S1.
2. Outbox row is committed `PENDING`.
3. Worker is down (k8s pod crashed). Outbox `pending` count grows.
4. Readiness probe of `next` app process returns 503 once `pending > threshold` OR `oldestPendingAgeSeconds > threshold`.
5. Operator sees the alert, restarts the worker. Worker drains the backlog within `O(backlog/throughput)`.

### S3 — DB outage during audit write (legacy void path)
1. Existing call site uses old `logAudit({ ... })` (still void).
2. `enqueueAudit` throws — DB unreachable.
3. The pre-outbox emergency RAM buffer accepts the entry.
4. On the next successful `logAudit` call, the buffer is drained piggyback.
5. If the process crashes before the next call, the entry is lost. (Same as today.) **Documented loss surface**, addressed only by migrating the call site to `logAuditInTx` inside an existing transaction.

### S4 — Worker crashes mid-flight (Phase 1)
1. Worker has claimed a batch of 100 rows (status `PROCESSING`).
2. Worker has inserted 30 of them into `audit_logs` and crashes.
3. The 30 rows remain `PROCESSING`, the other 70 also remain `PROCESSING`.
4. Reaper (Phase 2) eventually resets all 100 to `PENDING` after `processing_timeout`.
5. New worker claims them. For the 30 already inserted, the unique `outboxId` index causes the second insert to be a no-op (caught and treated as success). For the 70, the insert proceeds normally.

### S5 — Multi-target fan-out with one bad target (Phase 3)
1. Tenant has DB (always), webhook, SIEM, S3 targets.
2. User performs S1.
3. Outbox row is delivered to DB (always succeeds because DB is the same Postgres). `audit_logs` row created. Outbox row → `SENT`.
4. Three `audit_deliveries` rows created.
5. Webhook delivers OK. SIEM 500s. S3 OK.
6. SIEM `audit_deliveries` row is `PENDING` with retry; the others are `SENT`. SIEM retries on backoff until success or `failed`.

### S6 — Hash chain verification (Phase 4)
1. Tenant has `auditChainEnabled = true`.
2. Worker inserts each audit row with `chain_seq`, `prev_hash`, `event_hash` populated.
3. Operator runs `GET /api/maintenance/audit-chain-verify?tenantId=X`.
4. Endpoint walks the chain in order, recomputing each hash. Reports `OK` or `tampered at chain_seq=N`.

### S7 — Adding a new audit action that should NOT cause a webhook loop
1. Developer adds `AUDIT_OUTBOX_REAPED` to `enum AuditAction`.
2. They forget to add it to `OUTBOX_BYPASS_AUDIT_ACTIONS` and to `WEBHOOK_DISPATCH_SUPPRESS`.
3. Phase 2 includes a static test (`audit-bypass-coverage.test.ts`) that asserts every action whose name starts with `AUDIT_OUTBOX_` is present in both sets.

## Open questions for review

These are flagged for the expert agents to evaluate explicitly:

- ~~**Q1 (resolved)**: Keep void shim + two-path design. Phase 1 migrates security-critical call sites to `logAuditInTx`; remaining ~170 tracked in follow-up.~~
- **Q2 (security)**: Is the worker DB role design sufficient, or should the worker use a dedicated unencrypted-config file for the role password rather than env var injection? (Today, `passwd_app`'s password is also via env var.)
- ~~**Q3 (resolved)**: Use GitHub Actions postgres service in CI (matching `rls-smoke` pattern), dev docker-compose `db` container locally. No testcontainers.~~
- ~~**Q4 (resolved)**: FIFO + flusher is retained in Phase 1; removed in Phase 2 when `logAuditAsync` replaces `logAudit`.~~
- **Q5 (security)**: For Phase 3, should `audit_delivery_targets.config_encrypted` use the same envelope as `TeamWebhook.secretEncrypted` (master-key versioned) or a new, audit-specific master key for blast-radius isolation?
- **Q6 (functionality)**: Should we pre-populate the `audit_delivery_targets` row schema with a `kind=DB` always-on row per tenant, or special-case DB in the worker code? Current plan: special-case.
- ~~**Q7 (resolved)**: Use two-Prisma-client + Deferred barrier pattern in vitest. No separate harness needed.~~

## Implementation Checklist (Phase 1 only)

### Files to create
- [x] `src/lib/audit-outbox.ts` — `enqueueAuditInTx()`, `enqueueAudit()`
- [x] `src/lib/backoff.ts` — `computeBackoffMs()`, `withFullJitter()`
- [x] `src/workers/audit-outbox-worker.ts` — worker loop body
- [x] `scripts/audit-outbox-worker.ts` — worker entrypoint
- [x] `scripts/set-outbox-worker-password.sh` — prod password rollout
- [x] `vitest.integration.config.ts` — real-DB test config
- [ ] `src/__tests__/db-integration/audit-outbox-atomicity.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-logaudit-non-atomic.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-outbox-state-machine.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-outbox-skip-locked.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-outbox-rls.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-outbox-worker-role.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-outbox-dedup.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-outbox-reentrant-guard.integration.test.ts`
- [x] `src/__tests__/audit.mocked.test.ts` (renamed from `audit.test.ts`)
- [x] `src/__tests__/audit-fifo-flusher.test.ts`

### Files to modify
- [x] `prisma/schema.prisma` — add `AuditOutboxStatus` enum, `AuditOutbox` model, `outboxId` on `AuditLog`, `auditOutbox` relation on `Tenant`
- [x] `src/lib/tenant-rls.ts` — refactor `withBypassRls` signature to pass `tx` to callback (backward-compatible)
- [x] `src/lib/audit.ts` — rewrite `logAudit`/`logAuditBatch` to FIFO flusher + export `logAuditInTx`; add `OUTBOX_BYPASS_AUDIT_ACTIONS` to `WEBHOOK_DISPATCH_SUPPRESS`
- [x] `src/lib/audit-retry.ts` — changed to use enqueueAudit
- [x] `src/lib/constants/audit.ts` — add `AUDIT_OUTBOX` namespace with all configurable constants
- [x] `src/lib/webhook-dispatcher.ts` — (reverted backoff migration per F4; RETRY_DELAYS kept as original literal)
- [x] `infra/postgres/initdb/02-create-app-role.sql` — add `passwd_outbox_worker` role section
- [x] `package.json` — add `worker:audit-outbox` and `test:integration` scripts
- [x] `vitest.config.ts` — add `exclude: ["src/**/*.integration.test.ts"]`
- [ ] `docker-compose.yml` — add `audit-outbox-worker` service
- [ ] `.github/workflows/ci.yml` — add `audit-outbox-integration` job

### Shared utilities to reuse (R1 compliance)
- `src/lib/tenant-rls.ts:40-52` — `withBypassRls()`, `BYPASS_PURPOSE.AUDIT_WRITE`
- `src/lib/tenant-rls.ts:22` — `tenantRlsStorage` (AsyncLocalStorage, for flusher isolation)
- `src/lib/audit.ts:73-93` — `sanitizeMetadata()` (reuse, do not reimplement)
- `src/lib/audit.ts:22-28` — `truncateMetadata()` (reuse, do not reimplement)
- `src/lib/audit-logger.ts:22-41` — `METADATA_BLOCKLIST` (reuse, do not reimplement)
- `src/lib/audit-logger.ts` — `deadLetterLogger` (reuse for FIFO overflow)
- `src/lib/logger.ts` — `getLogger()` (reuse for structured logging)
- `src/lib/rate-limit.ts` — `createRateLimiter()` (reuse for metrics endpoint)
- `src/lib/admin-token.ts` — `verifyAdminToken()` (reuse for admin endpoints)
- `src/lib/constants/audit.ts` — `AUDIT_ACTION`, `AUDIT_SCOPE`, `AUDIT_ACTION_VALUES`
- `src/lib/validations/common.server.ts` — `METADATA_MAX_BYTES`, `USER_AGENT_MAX_LENGTH`

### Patterns to follow consistently
- Maintenance endpoint auth pattern: `verifyAdminToken` → `createRateLimiter` → `withBypassRls` → `logAudit` → JSON (from `purge-audit-logs/route.ts`)
- Migration pattern: `ALTER TYPE "EnumName" ADD VALUE 'VALUE'` one per statement (from `20260411123230_add_extension_bridge_codes`)
- Docker service pattern: `depends_on: db: condition: service_healthy` + `restart: unless-stopped`
- CI job pattern: GitHub Actions `services: postgres:` (from `rls-smoke` job)
- Test file convention: `.integration.test.ts` suffix for real-DB, `src/__tests__/db-integration/` directory

### Security-critical call sites to migrate to logAuditInTx in Phase 1
- [x] `src/lib/account-lockout.ts:274` — VAULT_UNLOCK_FAILED
- [x] `src/lib/account-lockout.ts:291` — VAULT_LOCKOUT_TRIGGERED
- [x] `src/app/api/share-links/verify-access/route.ts:73` — SHARE_ACCESS_VERIFY_FAILED (reverted to logAudit due to non-UUID userId)
- [x] `src/app/api/share-links/verify-access/route.ts:88` — SHARE_ACCESS_VERIFY_SUCCESS (reverted to logAudit)
- [x] `src/app/api/share-links/route.ts:190` — SHARE_CREATE
- [x] `src/app/api/share-links/[id]/route.ts:59` — SHARE_REVOKE
- [ ] DEFERRED: `src/auth.ts:340` — AUTH_LOGIN (NextAuth event callback, no transaction scope available)
- [ ] DEFERRED: `src/auth.ts:352` — AUTH_LOGOUT (NextAuth event callback, no transaction scope available)

## Implementation Checklist (Phase 3)

### Files to create
- [ ] `src/lib/external-http.ts` — extracted SSRF helpers, `validateAndFetch`, sanitization, `BLOCKED_CIDR_REPRESENTATIVES`
- [ ] `src/workers/audit-delivery.ts` — `deliverWebhook`, `deliverSiemHec`, `deliverS3Object`
- [ ] `src/__tests__/external-http-ssrf.test.ts` — SSRF rejection tests with guard assertion
- [ ] `src/__tests__/db-integration/audit-delivery-fanout.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-delivery-failure-isolation.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-delivery-rls.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-delivery-pii-sanitization.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-delivery-stuck-reaper.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-delivery-retention-purge.integration.test.ts`
- [ ] `src/__tests__/db-integration/audit-outbox-worker-role.integration.test.ts`
- [ ] `src/workers/audit-delivery.test.ts` — deliverer unit tests (webhook, SIEM HEC, S3)

### Files to modify
- [ ] `src/lib/webhook-dispatcher.ts` — re-export extracted symbols from `external-http.ts`
- [ ] `prisma/schema.prisma` — add `AuditDeliveryTargetKind`, `AuditDeliveryStatus` enums, `AuditDeliveryTarget`, `AuditDelivery` models, back-relations on `AuditOutbox` and `Tenant`
- [ ] `prisma/migrations/<ts>_add_audit_delivery_targets/migration.sql` — tables, RLS, FORCE RLS, tenant_isolation policies, worker grants, indexes
- [ ] `src/lib/constants/audit.ts` — add `AUDIT_DELIVERY_FAILED`, `AUDIT_DELIVERY_DEAD_LETTER` actions, update `OUTBOX_BYPASS_AUDIT_ACTIONS`, `WEBHOOK_DISPATCH_SUPPRESS`, `AUDIT_ACTION_GROUP.MAINTENANCE`, `AUDIT_ACTION_VALUES`
- [ ] `messages/en/AuditLog.json` — add i18n labels for new actions
- [ ] `messages/ja/AuditLog.json` — add i18n labels for new actions
- [ ] `src/workers/audit-outbox-worker.ts` — add delivery fan-out (second pass), extend reaper for delivery rows, extend purge for delivery retention
- [ ] `infra/postgres/initdb/02-create-app-role.sql` — add grants for `audit_delivery_targets` and `audit_deliveries`
- [ ] `scripts/check-bypass-rls.mjs` — add Phase 3 files to allowlist

### Shared utilities to reuse (R1 compliance)
- `src/lib/webhook-dispatcher.ts:107-183` — SSRF helpers (extract, don't reimplement)
- `src/lib/webhook-dispatcher.ts:63-72` — `WEBHOOK_METADATA_BLOCKLIST` (rename+extend, don't duplicate)
- `src/lib/webhook-dispatcher.ts:81-100` — `sanitizeWebhookData` (extract+rename, don't duplicate)
- `src/lib/crypto-server.ts:60-82` — `encryptServerData` (reuse with AAD)
- `src/lib/crypto-server.ts:85-104` — `decryptServerData` (reuse with AAD)
- `src/lib/backoff.ts` — `computeBackoffMs`, `withFullJitter` (reuse for delivery retries)
- `src/lib/rate-limit.ts` — `createRateLimiter` (reuse for per-target rate limiting)
- `src/lib/ip-access.ts` — `isIpInCidr` (already used by SSRF helpers)
- `src/lib/tenant-rls.ts` — `withBypassRls`, `BYPASS_PURPOSE` (reuse for delivery fan-out)
- `src/lib/constants/audit.ts:644-654` — `AUDIT_OUTBOX` constants (reuse for delivery timeouts)

### Patterns to follow consistently
- Outbox claim pattern: `FOR UPDATE SKIP LOCKED` (from `claimBatch()` at worker:84-107)
- Stuck reaper pattern: reset `PROCESSING` → `PENDING` after timeout (from `reapStuckRows()` at worker:327-383)
- Direct audit logging pattern: `writeDirectAuditLog()` for meta-events (from worker:175-210)
- Bypass RLS pattern: `setBypassRlsGucs()` per transaction (from worker:54-58)
- Re-export pattern: extract to new module, re-export from original (preserve API)
- Webhook encryption pattern: `String` types for encrypted/iv/authTag (from TeamWebhook schema)
