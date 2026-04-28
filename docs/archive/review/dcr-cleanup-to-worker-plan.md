# Plan: dcr-cleanup-to-worker

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + PostgreSQL 16)
- **Test infrastructure**: unit (vitest) + integration (real DB) + E2E (Playwright) + CI/CD (GitHub Actions)

## Objective

Replace `POST /api/maintenance/dcr-cleanup` with a background sweeper process so that **tenant-admin op_\* tokens never reach system-level rows**. Today's endpoint operates on `mcp_clients` rows where `tenant_id IS NULL` (unclaimed expired DCR registrations), authorised by a tenant-admin's bearer token. The deletion is benign GC, but the *capability* — a tenant-admin's token executing a query whose WHERE filter is the only thing keeping it scoped — is a latent privilege escalation footgun (carry-over from PR #410 review). Removing the API and moving the work to a worker eliminates this code path entirely.

**Honest framing of the privilege improvement** (revised after Round 1 review):

The improvement is *real* but more nuanced than "no BYPASSRLS = stronger isolation". The worker MUST set `app.bypass_rls='on'` GUC inside its own transactions to match `tenant_id IS NULL` rows under the existing RLS policy — same mechanism the audit-outbox-worker uses. The actual gains:

| Axis | Pre-fix | Post-fix |
|---|---|---|
| Credential surface | Many op_* tokens (tenant admin convenience, frequent rotation) | One worker DB password (ops-controlled rotation) |
| Threat vector | Tenant admin compromise (medium probability) | Infra-team k8s/secrets compromise (lower probability) |
| Audit attribution | `actorType=HUMAN` with the operator's userId + their tenant (misleading — the action wasn't tenant-scoped) | `actorType=SYSTEM` with `userId=SYSTEM_ACTOR_ID` and `tenantId=SYSTEM_TENANT_ID` (forensically unambiguous) |
| In-process gate | Authn (op_* token validate) + authz (tenant-admin role) + WHERE filter | Role grants (`SELECT, DELETE` on `mcp_clients` only) + WHERE filter |
| DoS reach if credential leaks | op_* token → DELETE only matching `(is_dcr=true ∧ tenant_id=null ∧ expired)` rows (the route's WHERE filter constrains the call) | worker password + `app.bypass_rls='on'` → DELETE any `mcp_clients` row (role grant is broader than the worker code's WHERE filter; an attacker controls the WHERE) |

The WHERE filter remains load-bearing in both cases. The substantive improvement is that the **caller** of the deletion shifts from a many-token tenant-admin path to a single ops-controlled worker.

## Requirements

### Functional

- Sweeper deletes `mcp_clients` rows where `is_dcr = true AND tenant_id IS NULL AND dcr_expires_at < now()`, periodically.
- **Per-sweep audit emission** uses `scope=AUDIT_SCOPE.TENANT` with sentinel `tenantId=SYSTEM_TENANT_ID`, `actorType=ACTOR_TYPE.SYSTEM`, `userId=SYSTEM_ACTOR_ID`, `action=AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP`. Emission occurs in the **same transaction** as the DELETE so that DELETE-rollback and audit-rollback are atomic.
- Heartbeat audit (when `purgedCount=0`) is **off by default** — controlled by env knob `DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT` (boolean, default `false`). When `true`, every sweep emits an audit row regardless of count. When `false`, only sweeps with `purgedCount > 0` emit audit. Either way, every sweep emits a structured Pino log line for k8s/Docker log-based observability.
- Configurable sweep interval and batch cap via env vars (see §Env vars).
- Graceful shutdown on `SIGTERM` / `SIGINT`: stop accepting new sweeps, finish in-flight DELETE+audit transaction, exit 0. Use `node:timers/promises` `setTimeout` with `AbortSignal` (AbortSignal-aware native API; no invented helpers).
- `--validate-env-only` CLI flag exits 0 after env parse, without touching DB (mirrors outbox worker pattern, used by k8s readiness checks).
- **API removal with deprecation window**: `POST /api/maintenance/dcr-cleanup` returns `410 Gone` with body `{ error: "endpoint_removed", replacement: "worker:dcr-cleanup" }` for one minor version. The stub also emits an audit event (action `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL`) so operators discover stale cron jobs via their existing audit pipeline. Stub deleted in the next minor release.

### Non-functional

- New DB role `passwd_dcr_cleanup_worker` with `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`. Grants:
  - `USAGE` on schema `public`
  - `SELECT, DELETE` on `mcp_clients`
  - `SELECT, INSERT` on `audit_outbox`
  - `SELECT` on `tenants` (FK validation for the sentinel-tenant audit row)
  - `NOBYPASSRLS` is the role attribute. The worker uses `app.bypass_rls='on'` GUC inside its own tx (raw `SELECT set_config(...)`) — this is the necessary bypass for the `tenant_id IS NULL` rows and for inserting into `audit_outbox` whose RLS policy keys on `app.tenant_id`.
- New sentinel tenant row: `id = SYSTEM_TENANT_ID = "00000000-0000-4000-8000-000000000002"`, `name = "__system__"`, used solely for SYSTEM-scope audit attribution.
- Process model identical to `audit-outbox-worker`: long-running tsx process, separate Docker service, separate k8s Deployment.
- Worker constructs its own `pg.Pool` from `DCR_CLEANUP_DATABASE_URL`, instantiates a separate `PrismaClient`. **Does NOT import `@/lib/tenant-rls` or `@/lib/prisma`** — those use the app pool, which would silently route the worker's queries through the `passwd_app` connection.

### Env vars

- `DCR_CLEANUP_DATABASE_URL` (required, URL) — DB connection for the worker role
- `DCR_CLEANUP_INTERVAL_MS` (int, default `3_600_000` = 1h, min `60_000` = 1min)
- `DCR_CLEANUP_BATCH_SIZE` (int, default `1000`, min `1`, max `10_000`)
- `DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT` (boolean, default `false`)

## Technical approach

### File layout

| New / changed | Path | Purpose |
|---|---|---|
| New | `src/workers/dcr-cleanup-worker.ts` | `createWorker(config)` exporting `start()/stop()`. Loop = `while !signal.aborted { try await sweepOnce(); ... await setTimeout(intervalMs, undefined, { signal }); }`. |
| New | `src/workers/dcr-cleanup-worker.test.ts` | Unit test: mocked own-Prisma, asserts SQL where clause, audit emission shape (strict), zero-row + non-zero-row paths under both heartbeat-knob settings, signal handling, abort-during-sweep semantics. |
| New | `scripts/dcr-cleanup-worker.ts` | Env validation entry; mirrors `scripts/audit-outbox-worker.ts`. Uses `envObject.pick({...})` so non-worker env vars are not required. Supports `--validate-env-only`. |
| New | `scripts/__tests__/dcr-cleanup-worker-env.test.mjs` | Byte-exact env-validation contract test (matches `scripts/__tests__/audit-outbox-worker-env.test.mjs` style: `extractJsonLine` + `toEqual`). |
| New | `prisma/migrations/<ts>_add_dcr_cleanup_worker_role_and_system_tenant/migration.sql` | (1) Creates `passwd_dcr_cleanup_worker` role + grants; (2) inserts the sentinel tenant row `(SYSTEM_TENANT_ID, '__system__', ...)` `ON CONFLICT (id) DO NOTHING`. **Migration creates ONLY the `tenants` row — NO `tenant_members`, NO `tenant_policies`, NO `tenant_webhooks` for the sentinel.** Zero memberships is what prevents tenant-admin endpoints from elevating to the sentinel (no logged-in user can resolve `actor.tenantId` to it). Uses `current_database()` (R15). |
| New | `scripts/set-dcr-cleanup-worker-password.sh` | Mirrors `set-outbox-worker-password.sh`. **Reads password from stdin** (not command-line env) to avoid shell history / kubectl audit / `ps` leak. Same fix applied to outbox bootstrap script in this PR. |
| New | `infra/k8s/dcr-cleanup-worker.yaml` | k8s Deployment manifest. |
| New | `src/__tests__/db-integration/dcr-cleanup-worker-role.integration.test.ts` | Integration: real DB, asserts (a) role can DELETE matching rows after setting bypass_rls GUC, (b) role CANNOT DELETE rows with `tenant_id IS NOT NULL` (RLS denies), (c) role CANNOT DELETE from `tenants` / `users` / `audit_logs` (no grants), (d) role CAN INSERT into `audit_outbox` with sentinel tenantId. |
| New | `src/__tests__/db-integration/dcr-cleanup-worker-sweep.integration.test.ts` | Integration: real DB; seed all 8 boundary combinations of (is_dcr × tenant_id × dcr_expires_at); run `sweepOnce(batchSize=20)`; assert exactly the (true, null, expired) row is deleted and a sentinel-tenant audit_outbox row is inserted with strict-shape assertion. |
| New | `src/__tests__/db-integration/dcr-cleanup-worker-tx-rollback.integration.test.ts` | Integration: real DB; simulate audit-emission failure inside the tx; assert DELETE rolled back AND no audit_outbox row landed. Proves R9 atomicity. |
| Changed | `src/__tests__/db-integration/helpers.ts` | Extend `createPrismaForRole()` to accept `"dcr-cleanup-worker"`. Add `dcrWorker: PrismaWithPool` to `TestContext`. Reuse `DCR_CLEANUP_DATABASE_URL` env var (same pattern as outbox uses `OUTBOX_WORKER_DATABASE_URL`). Fallback substitution rule mirrors outbox: `base.replace(/\/\/[^:]+:[^@]+@/, "//passwd_dcr_cleanup_worker:passwd_dcr_pass@")`. CI workflow `.github/workflows/test.yml` (or equivalent — verify actual filename during implementation) must add `DCR_CLEANUP_DATABASE_URL` to the env block of integration-test jobs. |
| Changed | `src/lib/constants/app.ts` | Add `SYSTEM_TENANT_ID = "00000000-0000-4000-8000-000000000002" as const`. |
| Changed | `src/app/api/maintenance/dcr-cleanup/route.ts` | Replace handler body with 410 Gone stub returning `{ error: "endpoint_removed", replacement: "worker:dcr-cleanup" }` + audit emission `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL`. |
| Changed | `src/app/api/maintenance/dcr-cleanup/route.test.ts` | Update tests to verify 410 status + body + audit shape. Drop the legacy success-path tests. |
| Changed | `src/lib/constants/audit/audit.ts` | Add `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL` action constant; place in `AUDIT_ACTION_GROUPS_TENANT[MCP_CLIENT]` group; add to action list array. |
| (Verified — no change) | `src/lib/audit/audit-outbox.ts` | `enqueueAuditInTx` already honors caller-set GUCs (verified at `audit-outbox.ts:25-32`). No changes needed. |
| Changed | `package.json` | Add `"worker:dcr-cleanup": "tsx scripts/dcr-cleanup-worker.ts"`. |
| Changed | `src/lib/env-schema.ts` | Add `DCR_CLEANUP_*` fields with Zod validators. |
| Changed | `.env.example` | Regenerated via `npm run generate:env-example`. |
| Changed | `scripts/env-allowlist.ts` | Add `DCR_CLEANUP_DATABASE_URL`, `DCR_CLEANUP_INTERVAL_MS`, `DCR_CLEANUP_BATCH_SIZE`, `DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT`, `PASSWD_DCR_CLEANUP_WORKER_PASSWORD`. |
| Changed | `scripts/env-descriptions.ts` | Add descriptions for the same 5 env vars. |
| Changed | `docker-compose.override.yml` | Add `dcr-cleanup-worker` service mirroring `audit-outbox-worker` exactly (incl. `depends_on.migrate` with `condition: service_completed_successfully` AND `required: false`). |
| Changed | `scripts/checks/check-bypass-rls.mjs` | Verified: the script scans for `withBypassRls(` invocations only (line 122) — raw `SELECT set_config(...)` is NOT detected. The audit-outbox-worker.ts (which uses raw set_config) is NOT in the current allowlist; the new dcr-cleanup-worker.ts will follow the same pattern and require no allowlist entry. **However**, the existing entry for the route file `["src/app/api/maintenance/dcr-cleanup/route.ts", ["mcpClient"]]` (line 100) MUST be updated to `[]` (empty model list) because the 410 stub no longer touches `mcpClient` — its only DB action is `logAuditAsync`, which does not involve `withBypassRls()` at the stub call site. |
| Changed | `docs/operations/admin-tokens.md` | Replace dcr-cleanup curl example with one-line note + 410 deprecation explanation. |
| Changed | `docs/operations/incident-runbook.md` | Verify and mark "no change required" if no dcr-cleanup reference (current grep returns 0). |
| Changed | `docs/operations/audit-log-reference.md:366` | Update `MCP_CLIENT_DCR_CLEANUP` row: scope stays TENANT (sentinel attribution), metadata changes to `{purgedCount, triggeredBy: "dcr-cleanup-worker", sweepIntervalMs}`. Add new row for `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL`. |
| Changed | `messages/en/AuditLog.json:191` and `messages/ja/AuditLog.json:191` | Update wording to reflect SYSTEM actor. Add entry for the new deprecated-call action. |
| Changed | `CLAUDE.md` | Remove `dcr-cleanup` from the maintenance API table (or mark deprecated → 410). Add `worker:dcr-cleanup` next to `worker:audit-outbox`. |

### Audit emission shape (revised)

The exact payload shape MUST match the `AuditOutboxPayload` interface defined at `src/lib/audit/audit-outbox.ts:6-18`. Fields verified against the actual source:

```ts
// Inside tx with app.bypass_rls='on' (worker has set the GUC at tx start).
// tenant_id GUC need not be set — bypass_rls overrides RLS row visibility.
await enqueueAuditInTx(tx, SYSTEM_TENANT_ID, {
  scope: AUDIT_SCOPE.TENANT,
  action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP,
  userId: SYSTEM_ACTOR_ID,
  actorType: ACTOR_TYPE.SYSTEM,
  serviceAccountId: null,
  teamId: null,
  targetType: null,
  targetId: null,
  metadata: {
    [AUDIT_METADATA_KEY.PURGED_COUNT]: deleted,
    triggeredBy: "dcr-cleanup-worker",
    sweepIntervalMs,
  },
  ip: null,
  userAgent: "dcr-cleanup-worker",
});
```

`enqueueAuditInTx` (verified at `src/lib/audit/audit-outbox.ts:20-47`) (a) checks the tenants-FK existence — passes because sentinel exists post-migration; (b) writes to audit_outbox under the caller's tx — composable; (c) honours the GUCs the caller has set on the same tx. No new helper needed; do NOT import `@/lib/audit/audit` (its `logAuditInTx` transitively imports `@/lib/prisma`, contradicting the worker's own-pool requirement).

### 410 deprecation-stub audit emission shape

The stub authenticates the caller (preserves the legacy 401 path for unauthenticated calls) so that the operator's `tokenSubjectUserId` is captured for stale-cron-job detection. Flow (audit emit happens AFTER rate limit — preserves legacy ordering AND prevents flooding via rate-limited 429 storms):

1. `verifyAdminToken(req)` → if invalid, return 401 (preserves current contract).
2. Rate limiter (`rl:admin:dcr-cleanup`, windowMs=60_000, max=1) — same as legacy. Rate-limited calls return 429 WITHOUT audit emission. The first valid call per minute reaches step 3, ensuring at least one audit event/minute for any caller — sufficient for operators to discover stale cron jobs (cron typically runs daily/hourly, so the rate limit is rarely a visibility blocker).
3. `requireMaintenanceOperator(...)` — kept; if the operator is no longer admin, return 400 (preserves contract).
4. Emit audit:

```ts
await logAuditAsync({
  ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
  actorType: ACTOR_TYPE.HUMAN,
  action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL,
  metadata: {
    tokenSubjectUserId: auth.subjectUserId,
    tokenId: auth.tokenId,
    deprecated: true,
    replacement: "worker:dcr-cleanup",
  },
});
```

5. Return `410 Gone` with body `{ error: "endpoint_removed", replacement: "worker:dcr-cleanup" }`.

**Strict-shape assertions for the deprecation audit metadata** (route.test.ts):
- MUST appear: `tokenSubjectUserId`, `tokenId`, `deprecated: true`, `replacement: "worker:dcr-cleanup"`.
- MUST NOT appear: `purgedCount`, `triggeredBy`, `sweepIntervalMs`, `systemWide`.

`scope: TENANT` with `tenantId: auth.tenantId` — i.e. the caller's tenant. This makes the deprecation event visible in `/api/tenant/audit-logs` for the operator's own tenant admin, preserving the discoverability the deprecation window depends on. Distinct from worker-emitted events (which use `tenantId: SYSTEM_TENANT_ID` and are NOT visible to any tenant admin's UI).

### Loop shape (revised)

```ts
import { setTimeout as setTimeoutPromise } from "node:timers/promises";

async function loop({ intervalMs, batchSize, signal }: LoopOpts) {
  log.info({ intervalMs, batchSize }, "dcr-cleanup.loop_start");
  while (!signal.aborted) {
    try {
      const purged = await sweepOnce(batchSize);
      log.info({ purged }, "dcr-cleanup.sweep_done");
    } catch (err) {
      // Pin error log shape to {code, msg} only — do NOT spread err — to avoid
      // leaking pg connection target / username via err.message (mirror S14
      // boot-time auth-fail contract). Unit test asserts log payload does NOT
      // contain connection-string substrings.
      const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
      log.error({ code }, "dcr-cleanup.sweep_failed");
      // Do NOT exit; transient DB errors should not crash the worker.
    }
    if (signal.aborted) break;
    try {
      await setTimeoutPromise(intervalMs, undefined, { signal });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ABORT_ERR") break;
      throw err;
    }
  }
  log.info({}, "dcr-cleanup.loop_stopped");
}
```

`sweepOnce(batchSize)` opens a tx, sets bypass_rls + tenant_id GUCs, runs `$executeRawUnsafe` for `DELETE ... USING (SELECT id FROM mcp_clients WHERE is_dcr=true AND tenant_id IS NULL AND dcr_expires_at < now() LIMIT $1) sub WHERE mcp_clients.id = sub.id` (returns affected row count as `number`), emits audit via `enqueueAuditInTx` only if `purged > 0` OR `emitHeartbeatAudit=true`, returns the count. **Single-flight is structural** (the loop awaits `sweepOnce` before sleeping) — no separate primitive needed; no test required (a code comment in the worker explains this).

## Implementation steps (in order)

0. **Pre-step (optional, may be a separate small PR if convenient)**: Update `scripts/set-outbox-worker-password.sh` to read password from stdin (S6 fix applied to existing pattern). Update `docs/operations/admin-tokens.md` outbox bootstrap section to reflect the new pattern. Apply the same shape to the new `set-dcr-cleanup-worker-password.sh` from the start.
1. Add `SYSTEM_TENANT_ID` to `src/lib/constants/app.ts` + unit test asserting it's a valid UUID and distinct from `SYSTEM_ACTOR_ID` / `ANONYMOUS_ACTOR_ID`.
2. Add `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL` to `src/lib/constants/audit/audit.ts`: action constant, action-list array, group placement (`AUDIT_ACTION_GROUPS_TENANT[MCP_CLIENT]`), i18n keys. Update `AUDIT_ACTION_GROUP` enum if needed.
3. Add Prisma migration `<ts>_add_dcr_cleanup_worker_role_and_system_tenant`: creates the role + grants, inserts the sentinel tenant row.
4. Extend `src/__tests__/db-integration/helpers.ts` with `dcr-cleanup-worker` role support (T2 fix).
5. Add env-schema fields + regenerate `.env.example` + update `env-allowlist.ts` and `env-descriptions.ts`.
6. Add `src/workers/dcr-cleanup-worker.ts` (`createWorker(config)`, `sweepOnce(batchSize)` returning `number`).
7. Add `src/workers/dcr-cleanup-worker.test.ts` (vitest, mocked own-Prisma; pin `$executeRawUnsafe` return type to `Promise<number>`).
8. Add `scripts/dcr-cleanup-worker.ts` entry + `scripts/__tests__/dcr-cleanup-worker-env.test.mjs` (5 env-validation cases enumerated in §Testing strategy).
9. Add npm script `worker:dcr-cleanup`.
10. Add `scripts/set-dcr-cleanup-worker-password.sh` (stdin-based) + add password env var to docker compose.
11. Add `dcr-cleanup-worker` service in `docker-compose.override.yml`.
12. Add `infra/k8s/dcr-cleanup-worker.yaml`.
13. Add the three integration tests (role-grant, sweep, tx-rollback).
14. Replace `src/app/api/maintenance/dcr-cleanup/route.ts` with the 410 Gone stub. Update `route.test.ts` for the new behavior.
15. Update docs (`admin-tokens.md`, `incident-runbook.md` verify-no-change, `audit-log-reference.md`, `messages/{en,ja}/AuditLog.json`, `CLAUDE.md`).
16. Run `npm run db:migrate` against dev DB to confirm migration applies cleanly (memory feedback: `feedback_run_migration_on_dev_db.md`).
17. Run `bash scripts/pre-pr.sh` — must reach 11/11. If `check-bypass-rls.mjs` reports a violation against the new worker file, add an allowlist entry and re-run.

Steps 1-3 are independent and can be parallel commits if convenient. Step 14 (route → 410 stub) must come *after* Step 6 (worker exists) so a passing implementation exists before the API surface changes.

## Testing strategy

### Unit (vitest)

`dcr-cleanup-worker.test.ts`:

- `sweepOnce(batchSize)` builds a `DELETE` with `LIMIT batchSize` and the WHERE clause `is_dcr = true AND tenant_id IS NULL AND dcr_expires_at < now()` (assert via mocked `$executeRawUnsafe` call args).
- `sweepOnce` mocked Prisma return: `Promise<number>` (R7 fix). Assert `metadata.purgedCount === N`.
- When `purgedCount > 0`: emits audit via mocked `enqueueAuditInTx` exactly once with strict-shape assertion. Expected fields: `scope: AUDIT_SCOPE.TENANT`, `tenantId: SYSTEM_TENANT_ID`, `userId: SYSTEM_ACTOR_ID`, `actorType: ACTOR_TYPE.SYSTEM`, `action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP` (imported, not literal string — RT3), `metadata: { purgedCount: N, triggeredBy: "dcr-cleanup-worker", sweepIntervalMs }`. Assert ABSENCE of legacy fields: `expect(metadata.operatorId).toBeUndefined(); expect(metadata.tokenId).toBeUndefined(); expect(metadata.tokenSubjectUserId).toBeUndefined(); expect(metadata.systemWide).toBeUndefined()`.
- When `purgedCount === 0` AND `emitHeartbeatAudit=true`: emits audit with `purgedCount: 0`.
- When `purgedCount === 0` AND `emitHeartbeatAudit=false`: does NOT emit audit (assert `mockEnqueueAuditInTx.notCalled`). T6 fix.
- Loop honours abort signal: `controller.abort()` causes `loop()` to resolve within the next tick (test with `vi.useFakeTimers()` + `runAllTimersAsync`). The `node:timers/promises` `setTimeout` rejects with `AbortError` on abort; the loop catches and exits.
- Audit module mock pattern: use `vi.mock("@/lib/audit/audit-outbox", async (importOriginal) => ({ ...(await importOriginal()), enqueueAuditInTx: vi.fn() }))` to ensure new exports default to real implementations (T8 fix). For `@/lib/audit/audit`, no new exports are added (no `systemAuditBase`).

`audit.ts` does NOT need a new helper. Drop `systemAuditBase` from the original plan.

### Integration (real DB)

`dcr-cleanup-worker-role.integration.test.ts`:
- Connect as `passwd_dcr_cleanup_worker` via the extended `helpers.ts`.
- Assert `BEGIN; SELECT set_config('app.bypass_rls','on',true); DELETE FROM mcp_clients WHERE is_dcr=true AND tenant_id IS NULL AND dcr_expires_at < now(); COMMIT;` succeeds (zero or more rows affected).
- Assert `BEGIN; DELETE FROM mcp_clients WHERE id = $1; COMMIT;` (a row with `tenant_id IS NOT NULL`) FAILS — RLS denies because `app.bypass_rls` was not set this time and the worker role has `NOBYPASSRLS`.
- Assert `DELETE FROM tenants WHERE id = $1` is denied (no DELETE grant).
- Assert `DELETE FROM audit_logs WHERE id = $1` is denied (no DELETE grant on audit_logs).
- Assert `INSERT INTO audit_outbox (tenant_id, payload, ...)` with `tenant_id = SYSTEM_TENANT_ID` succeeds inside a tx with bypass_rls + tenant_id GUCs set.

`dcr-cleanup-worker-sweep.integration.test.ts`:
- Seed 9 rows: 8 rows covering all 2³ combinations of three binary axes — `is_dcr ∈ {true, false}` × `tenant_id ∈ {null, real_uuid}` × `dcr_expires_at ∈ {past (-1h), future (+1h)}` — plus 1 boundary row `(is_dcr=true, tenant_id=null, dcr_expires_at = $now_at_seed)` where `$now_at_seed` is captured immediately before seeding via `SELECT now()` from the test session. Run `sweepOnce` ≥1 microsecond later. The strict-less-than predicate (`<`, not `<=`) MUST NOT match this row at the moment of test seed (microsecond resolution makes equality stable enough); a subsequent sweep one second later WOULD match — that's intentional, proves the predicate is `<`. The (true, null, past) row is the only target deleted by the first `sweepOnce`.
- Run `sweepOnce(batchSize=20)`.
- Assert exactly 1 row deleted (the target). Other 8 remain.
- Assert `audit_outbox` has one new pending row with strict-shape payload (use `import { AUDIT_ACTION }` for action assertion).
- Drive the chain-anchor assertion **in-process**: import `deliverRowWithChain` from `src/workers/audit-outbox-worker.ts` (already exported per grep at line 192) and invoke it on the freshly-inserted outbox row. Then assert `audit_chain_anchors` has a row for `SYSTEM_TENANT_ID` with `chain_seq >= 1`. **Do NOT spawn the audit-outbox-worker subprocess** — integration tests in this repo use in-process imports for cross-worker contracts (same rule applies to T14 tx-rollback test).

`dcr-cleanup-worker-tx-rollback.integration.test.ts`:
- The test imports `sweepOnce` from `src/workers/dcr-cleanup-worker.ts` and calls it **in-process**. Does NOT spawn the worker via `start()` (subprocess boundary breaks `vi.mock` propagation).
- Use `vi.mock("@/lib/audit/audit-outbox", async (importOriginal) => ({ ...(await importOriginal()), enqueueAuditInTx: vi.fn().mockRejectedValueOnce(new Error("simulated audit failure")) }))` so the audit emission throws on first call.
- Run `sweepOnce(batchSize=10)` — assert it throws.
- Assert the target rows remain (DELETE was rolled back).
- Assert no new audit_outbox row was inserted.

Do NOT use the alternative "temporarily DELETE the sentinel tenant" approach — the FK from `audit_outbox.tenant_id → tenants.id` blocks DELETE if any audit_outbox row exists, making test cleanup fragile.

**Rationale for `vi.mock` vs the existing `audit-outbox-atomicity.integration.test.ts:50-53` pattern**: the existing precedent throws inside the test's own `tx.$transaction` callback because that test owns the outer tx scope. In our case `sweepOnce` owns the tx callback (the test cannot inject a `throw` mid-tx), so `vi.mock` is the correct vector. This is the only place in this codebase where mid-tx audit-rollback must be tested via the mock-injection variant.

### --validate-env-only contract (`scripts/__tests__/dcr-cleanup-worker-env.test.mjs`)

Mirrors `audit-outbox-worker-env.test.mjs` style (extractJsonLine + toEqual). Test cases (assert structural fields only; do NOT assert absence of `received` because Zod's default error formatter echoes it — match the existing outbox script's actual behavior):

1. Valid env: process exits 0; stdout final line `{"level":"info","msg":"env validation passed"}`.
2. Missing `DCR_CLEANUP_DATABASE_URL`: process exits 1; stderr JSON line has `path: "DCR_CLEANUP_DATABASE_URL"` and a Zod `code` (e.g. `"invalid_type"`).
3. Malformed `DCR_CLEANUP_DATABASE_URL` (e.g. `"not-a-url"`): process exits 1; stderr JSON line has `path: "DCR_CLEANUP_DATABASE_URL"` and a Zod `code` (e.g. `"invalid_format"` for URL violation). Per the auth-fail logging contract, the connection-string value is allowed in stderr at this validation stage (it's user input from env, not a credential leak from the DB driver).
4. `DCR_CLEANUP_INTERVAL_MS` below 60_000 (e.g. `30_000`): process exits 1.
5. `DCR_CLEANUP_BATCH_SIZE` above 10_000 (e.g. `99_999`): process exits 1.

Separate test (worker-startup integration test, NOT env-validation): when the script proceeds past env validation and attempts a real DB connection that fails auth, the resulting log line MUST match the regex anchor `^\{"level":"error","msg":"db auth failed","code":"[A-Z0-9_]+"\}$` (no fields beyond `level, msg, code` — anything else fails the regex). This is a stronger assertion than substring-checking `localhost:5432`, which is fragile across deployment hostnames (IPv6, custom hosts). The regex contract pins both the field set AND the absence of stray fields.

### Bootstrap script tests (`scripts/__tests__/set-*-worker-password.test.mjs`)

Add minimal coverage for the password-setter scripts (both new dcr-cleanup and existing outbox after S6 fix). The scripts gain a `DRY_RUN=1` env var: when set, the script prints the would-be psql command (sanitized — password value replaced by `<REDACTED>` in the printout, but passes through to a `--print-args-file` fixture) and exits 0 WITHOUT invoking psql. This makes the "password reaches psql" assertion implementable without PATH-shadowing executables (which has no precedent in this repo per `scripts/__tests__/audit-outbox-worker-env.test.mjs`).

- `set-dcr-cleanup-worker-password.test.mjs`:
  - `exits 1 with structured error when stdin is empty/missing`.
  - `with DRY_RUN=1 + stdin "secret"`: process exits 0; printed args include `-v new_password=secret` (the script must construct the `-v` flag with the actual password value); `--print-args-file <tmpfile>` writes the captured args to a temp file for assertion.
  - `password value never appears in /proc/<pid>/cmdline`: spawn the script with DRY_RUN=1, pre-spawn capture the cmdline of the bash subprocess, assert the password string is absent.
- `set-outbox-worker-password.test.mjs`: identical shape, mirrors the new test.

**Implementation note**: The `--print-args-file` flag is added to both scripts. `psql -v new_password=...` is captured to the file ONLY when `DRY_RUN=1`; the file is mode-0600 written via `umask 077` (defense-in-depth — captured args may include the password until tests assert and delete).

### Coverage migration (old route.test.ts → new tests)

The 410 stub authenticates the caller (per §"410 deprecation-stub audit emission shape"), so legacy 401 / 429 / 400 paths are PRESERVED — only the success status changes from 200 to 410.

| Old test case | New location | Expected status |
|---|---|---|
| 401 unauth | `route.test.ts` | 401 (preserved) |
| 401 invalid token | `route.test.ts` | 401 (preserved) |
| 429 rate-limit | `route.test.ts` | 429 (preserved — rate limiter still gates the stub) |
| 401-before-429 ordering | `route.test.ts` | 401 first (preserved ordering) |
| 400 not-admin | `route.test.ts` | 400 (preserved — `requireMaintenanceOperator` still runs) |
| 200 deletes-N | Worker test: `dcr-cleanup-worker.test.ts: sweepOnce returns N` (mocked) + `dcr-cleanup-worker-sweep.integration.test.ts` (real DB) | n/a (stub returns 410 regardless of work) |
| 200 deletes-0 | Worker test: heartbeat-knob `true` → emits audit; `false` → no audit | n/a |
| audit-shape strict — worker emit | Worker test: assert ABSENCE of `operatorId/tokenId/tokenSubjectUserId/systemWide` | n/a |
| audit-shape strict — 410 stub emit (NEW) | `route.test.ts`: assert PRESENCE of `tokenSubjectUserId, tokenId, deprecated:true, replacement:"worker:dcr-cleanup"`; assert ABSENCE of `purgedCount, triggeredBy, sweepIntervalMs, systemWide` | 410 |

### Manual / live verification (post-merge to staging)

- Boot stack with `npm run docker:up`.
- Tail the worker container: `docker logs -f passwd-sso-dcr-cleanup-worker`. Expect `dcr-cleanup.sweep_done` log line at the configured interval.
- Insert a synthetic expired DCR row via `psql`; wait one interval; confirm the row is gone and `audit_logs` has a corresponding `MCP_CLIENT_DCR_CLEANUP` row with `actorType=SYSTEM, userId=SYSTEM_ACTOR_ID, tenantId=SYSTEM_TENANT_ID`.
- Hit the deprecated endpoint with a valid op_* token: confirm 410 + audit row emitted.

## Considerations & constraints

- **Sentinel tenant migration timing**: the migration must run before the worker boots. Existing `migrate` Docker service (one-shot) handles this — verify dependency in compose.
- **Password bootstrap secret-handling**: `scripts/set-dcr-cleanup-worker-password.sh` reads from stdin. Document for k8s: `kubectl exec --stdin ... -- bash scripts/set-... < <(kubectl get secret ... -o jsonpath='{.data.password}' | base64 -d)`. Apply the same fix to the existing outbox bootstrap script in this PR (S6 fix). On auth failure during initial connect, the worker logs **only** `{level:"error",msg:"db auth failed",code:err.code}` — explicitly NOT `err.message` or the full `err` object (pg errors include the username and connection target hostname in `.message`). A dedicated test in `dcr-cleanup-worker-env.test.mjs` (or a separate worker-startup test) asserts the connection string never appears in stderr.
- **Sentinel-tenant audit chain growth**: `audit_chain_anchors` uses `INSERT ... ON CONFLICT (tenant_id) DO NOTHING` per audit-outbox-worker — the sentinel chain auto-creates on first emission and stays separate from real-tenant chains (verified at `src/workers/audit-outbox-worker.ts:204-209`). With `DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT=false` (default), chain growth equals real cleanup events (low). With `true`, ~24/day forever. No GC contract — accept as monotonic.
- **Sentinel-tenant chain verification**: `audit-chain-verify` route requires `auth.tenantId === tenantId`; since no operator is bound to the sentinel, chain-verify of the sentinel is unavailable through the API. Operators verify the sentinel chain via direct DB script if needed (out of scope for this PR).
- **Tenant-enumerating callers**: `prisma.tenant.findMany()` callers (search-wide) — none currently iterate all tenants for user-facing display in this codebase (verified by grep). If a future feature does, add an `id != SYSTEM_TENANT_ID` filter for UX. Slug uniqueness: the existing `slugifyTenant()` helper (`src/lib/tenant/tenant-claim.ts:30`) strips underscores via `/[^a-z0-9]+/g`, so user-input slug `"__system__"` collapses to `"system"`. The sentinel's literal slug `"__system__"` cannot be produced by this slugifier from any user input — collision is impossible by construction.
- **Webhook fan-out for sentinel**: SYSTEM-attributed events with `tenantId=SYSTEM_TENANT_ID` query `tenantWebhook WHERE tenantId=SYSTEM_TENANT_ID` and return zero rows (sentinel has no webhooks — see migration entry above). No need to add to `WEBHOOK_DISPATCH_SUPPRESS`. Intentional.
- **TOCTOU on consent-Allow**: with default 1h sweep interval and `MCP_DCR_UNCLAIMED_EXPIRY_SEC` typically order-of-hours, the race window is small but nonzero. A user who opens the consent page at `dcr_expires_at - 1ms` and clicks Allow at `dcr_expires_at + 1ms` plus during a sweep gets `already_claimed` (misleading wording — actually swept). Out of scope for this PR; track follow-up. Plan-level note: do not configure `DCR_CLEANUP_INTERVAL_MS` shorter than `MCP_DCR_UNCLAIMED_EXPIRY_SEC * 0.5`.
- **Heartbeat audit volume**: with knob default `false`, audit volume from the worker is bounded by actual DCR registration churn (typically very low for self-hosted setups). With knob `true`, 24 events/day per environment + audit chain anchoring per tenant. The chain-anchored sentinel tenant accumulates rows monotonically — operators considering long-term retention should keep the knob default (false) and rely on Pino structured logs for liveness signal.
- **Webhook fan-out**: SYSTEM-attributed events with `tenantId=SYSTEM_TENANT_ID` do NOT match any real tenant's webhook subscription. Intentional — a tenant should not receive notifications about another tenant's (or system-wide) cleanup. SIEM / system-level observability uses Pino logs or direct DB queries.
- **Tenant audit-logs UI visibility**: `/api/tenant/audit-logs` filters by the requester's tenantId, so tenant admins do NOT see SYSTEM_TENANT_ID rows. Deliberate — the action does not affect their tenant's data. Document in `admin-tokens.md`.
- **Atomicity confirmation**: `enqueueAuditInTx(tx, SYSTEM_TENANT_ID, payload)` writes to `audit_outbox` using the caller's tx. The DELETE and audit-enqueue are in the SAME `tx.$transaction(async tx => { ... })` block, so a crash between them produces a transactional rollback (not silent deletion). Verified by `tx-rollback.integration.test.ts`.
- **Audit forgery (pre-existing, inherited)**: `enqueueAuditInTx` does not validate that `payload.actorType` matches the writing role's identity. Any code path with bypass-RLS + INSERT on audit_outbox can craft `actorType=SYSTEM` rows. This PR is the first production producer of SYSTEM rows but does NOT introduce the forgery risk — it inherits it. Track as a separate follow-up: gate `actorType: SYSTEM` outbox writes via a CHECK constraint or trigger that inspects `current_user`.
- **Deprecation window**: the 410 Gone stub stays for one minor version. Following minor release deletes the route entirely.
- **Heartbeat-knob env-change audit trail**: `DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT` toggles via redeploy with no in-app audit row of the configuration change. Operators should track this via their k8s/Argo audit pipeline; the app does not log env-change events. Out of scope.

### Known limitations (accepted risks)

- **Worker DB credential blast radius**: a leaked `passwd_dcr_cleanup_worker` password permits `DELETE FROM mcp_clients WHERE <attacker-controlled>` once `app.bypass_rls='on'` is set. The role grant is broader than the WHERE filter the worker code uses. Accepted because (a) password rotation discipline is enforceable at the k8s/secrets layer, (b) blast radius is `mcp_clients` only — no tenants/users/audit_logs DELETE, (c) the audit-outbox-worker pattern accepts the same risk shape. **Defense-in-depth follow-up**: a per-role RLS policy or DELETE trigger on `mcp_clients` restricting to `(is_dcr = true ∧ tenant_id IS NULL ∧ dcr_expires_at < now())` even with `bypass_rls=on` would close this gap; deferred to a separate PR (Postgres trigger semantics on DELETE require careful design — non-trivial).
- **Sentinel-tenant chain-verify is API-unreachable**: `audit-chain-verify` route requires `auth.tenantId === tenantId`; no operator is bound to `SYSTEM_TENANT_ID`, so chain verification of SYSTEM-attributed audit rows is only available via a direct-DB script. Accepted because forensic-grade chain verification is a privileged-operator workflow. **Follow-up**: add `scripts/verify-system-audit-chain.sh` (or extend `audit-chain-verify` route to accept a system-admin token type) — deferred.
- **Audit forgery via INSERT on audit_outbox** (pre-existing, inherited): any code path with bypass-RLS + INSERT can craft `actorType=SYSTEM` rows. This PR is the first production producer of SYSTEM rows but does not introduce the underlying risk. Tracked separately.

- **Out of scope (deferred)**:
  - Audit-forgery hardening (CHECK constraint on actorType vs current_user).
  - SYSTEM-scope audit-log dashboard for operators (currently DB-direct queries only).
  - Sentinel-tenant chain verification via API (route requires auth.tenantId match; sentinel has no operator). Use direct-DB scripts for forensic chain verify.
  - Reviewing other tenant-admin-token system-wide patterns (R3 propagation re-confirmed in PR #410 and Round 1 review of this PR — none currently identified in maintenance/*).

## User operation scenarios

1. **Standard new install (Docker dev)**: operator runs `npm run docker:up`. Migrate one-shot creates the role + sentinel tenant; the `dcr-cleanup-worker` container picks up password from `PASSWD_DCR_CLEANUP_WORKER_PASSWORD` (mirrors outbox pattern). Worker logs `dcr-cleanup.loop_start` and runs sweeps every hour. No manual intervention.
2. **Production k8s upgrade**: apply migration via existing Job → set password via `kubectl exec --stdin ... -- bash scripts/set-dcr-cleanup-worker-password.sh < secret-file` → apply Deployment manifest. Old curl-driven cron jobs must be removed; the 410 stub will emit deprecation-call audit events to surface stale callers.
3. **Local dev without Docker (`npm run dev`)**: operator runs `npm run worker:dcr-cleanup` in a separate terminal. Same `.env` file drives it.
4. **Disaster recovery — worker stuck**: expired DCR rows accumulate but cause no functional impact (no auth flow depends on already-expired rows). Operator restarts the worker. No drain command needed; next sweep handles up to `batchSize` rows; if more remain a WARN log instructs to lower the interval temporarily.
5. **Verifying behavior in staging**: insert synthetic row with `is_dcr=true, tenant_id=null, dcr_expires_at=now()-interval '1 hour'`; wait one sweep; confirm gone via psql; confirm `audit_logs` has the `MCP_CLIENT_DCR_CLEANUP` row with `userId = SYSTEM_ACTOR_ID, tenantId = SYSTEM_TENANT_ID`.
6. **Operator with existing cron job**: post-upgrade their cron call returns 410 + audit event. They see the deprecation-call event in their tenant audit log (via `/api/tenant/audit-logs`) and remove the cron job. Stub deleted in next minor — calls to a removed route then 404 as Next.js default.
7. **Audit forensics**: SYSTEM-attributed events queryable via DB-direct (e.g. `SELECT * FROM audit_logs WHERE tenant_id = '<SYSTEM_TENANT_ID>'`) or Pino-structured-log searches. Tenant admins cannot see them — by design, since the actions don't affect their data.

## Implementation Checklist (cross-check against `git diff main...HEAD` during code review)

- [ ] `src/lib/constants/app.ts` (add `SYSTEM_TENANT_ID`)
- [ ] `src/lib/constants/audit/audit.ts` (add `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL`)
- [ ] `prisma/migrations/<ts>_add_dcr_cleanup_worker_role_and_system_tenant/migration.sql`
- [ ] `src/__tests__/db-integration/helpers.ts` (extend with `dcr-cleanup-worker` role)
- [ ] `src/lib/env-schema.ts` + regenerated `.env.example`
- [ ] `scripts/env-allowlist.ts`
- [ ] `scripts/env-descriptions.ts`
- [ ] `src/workers/dcr-cleanup-worker.ts`
- [ ] `src/workers/dcr-cleanup-worker.test.ts`
- [ ] `scripts/dcr-cleanup-worker.ts`
- [ ] `scripts/__tests__/dcr-cleanup-worker-env.test.mjs`
- [ ] `package.json` (`worker:dcr-cleanup`)
- [ ] `scripts/set-dcr-cleanup-worker-password.sh` (stdin-based)
- [ ] `scripts/set-outbox-worker-password.sh` (S6 fix to existing pattern)
- [ ] `scripts/__tests__/set-dcr-cleanup-worker-password.test.mjs`
- [ ] `scripts/__tests__/set-outbox-worker-password.test.mjs` (T19 — first-time coverage for the existing script)
- [ ] `docker-compose.override.yml`
- [ ] `infra/k8s/dcr-cleanup-worker.yaml`
- [ ] `src/__tests__/db-integration/dcr-cleanup-worker-role.integration.test.ts`
- [ ] `src/__tests__/db-integration/dcr-cleanup-worker-sweep.integration.test.ts`
- [ ] `src/__tests__/db-integration/dcr-cleanup-worker-tx-rollback.integration.test.ts`
- [ ] `src/app/api/maintenance/dcr-cleanup/route.ts` (replace with 410 Gone stub)
- [ ] `src/app/api/maintenance/dcr-cleanup/route.test.ts` (rewrite for 410 behavior)
- [ ] `docs/operations/admin-tokens.md`
- [ ] `docs/operations/incident-runbook.md` (verify-no-change)
- [ ] `docs/operations/audit-log-reference.md`
- [ ] `messages/en/AuditLog.json`
- [ ] `messages/ja/AuditLog.json`
- [ ] `CLAUDE.md`
