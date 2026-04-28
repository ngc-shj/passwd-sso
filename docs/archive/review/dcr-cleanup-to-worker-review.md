# Plan Review: dcr-cleanup-to-worker

Date: 2026-04-28

## Round 1 (initial)

## Functionality Findings

### F1 [Critical]: AUDIT_SCOPE.SYSTEM not in Prisma enum — design unimplementable

- File: `docs/archive/review/dcr-cleanup-to-worker-plan.md` (audit emission section); `prisma/schema.prisma` (`enum AuditScope { PERSONAL TEAM TENANT }`); `src/lib/constants/audit/audit.ts:7-15`
- Evidence: `grep -rn "AUDIT_SCOPE.SYSTEM" src/` returns zero hits in production code (only test fixtures). `enum AuditScope` lacks `SYSTEM` variant in Prisma + DB. Plan's claim "previously only test fixtures used `AUDIT_SCOPE.SYSTEM`" is true, but the conclusion that we can produce SYSTEM-scope audit rows is wrong without a migration.
- Problem: `tx.$executeRawUnsafe ... $::"AuditScope"` will throw `invalid input value for enum AuditScope: SYSTEM` at runtime; TS-level `AuditLogParams.scope` type-check will also fail.
- Impact: Worker cannot insert any audit row. Every sweep silently fails, leaving rows undeleted (worse than today).
- Fix: Adopt scope=TENANT with sentinel `SYSTEM_TENANT_ID` constant. Drop `systemAuditBase` helper.

### F2 [Critical]: audit_logs/audit_outbox tenantId is NOT NULL + tenants FK existence check

- File: `prisma/schema.prisma:977,1023`; `src/lib/audit/audit-outbox.ts:34-40`
- Evidence: Both `audit_logs.tenantId` and `audit_outbox.tenantId` are `String @db.Uuid` (NOT NULL). FK `tenant Tenant @relation(...)`. `enqueueAuditInTx` runs `SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1)` and throws on miss. `resolveTenantId(SYSTEM_ACTOR_ID)` returns null → `logAuditAsync` dead-letters via `tenant_not_found`.
- Problem: SYSTEM-scope audit emission (no tenant) is rejected at three layers: schema NOT NULL, RLS, and the tenant-existence guard.
- Impact: Plan's "tenantId IS NULL for SYSTEM rows" assumption is unworkable. Every emission silently dead-letters.
- Fix: Pre-create a sentinel tenant row at DB-init / migration time: `SYSTEM_TENANT_ID = "00000000-0000-4000-8000-000000000002"`. Audit rows attribute to this sentinel. No schema NULLability change needed.

### F3 [Critical]: RLS denies `tenant_id IS NULL` rows without `app.bypass_rls='on'`

- File: `prisma/migrations/20260328075528_add_rls_machine_identity_tables/migration.sql:46-57`
- Evidence: RLS policy on `mcp_clients` is `USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on' OR tenant_id = current_setting('app.tenant_id', true)::uuid)`. NULL = NULL is NULL (not TRUE). Without `app.bypass_rls='on'`, target rows are invisible.
- Problem: Plan claims worker has `NOBYPASSRLS` and "must succeed with RLS active. Verified via integration test." Integration test will fail because zero rows match. Postgres role-level `NOBYPASSRLS` is INDEPENDENT from the GUC the app checks — the worker CAN call `SELECT set_config('app.bypass_rls','on',true)` even with NOBYPASSRLS at role level.
- Impact: Worker silently does nothing OR misrepresents the privilege boundary as stronger than it is.
- Fix: Worker MUST set `app.bypass_rls='on'` GUC inside its own tx (mirror audit-outbox-worker.ts:58-62 pattern). Drop "no BYPASSRLS = privilege boundary" framing — privilege boundary is the role's GRANT set + the WHERE filter in worker code. Document honestly in plan.

### F4 [Major]: Atomicity strategy invokes nonexistent `logAudit`

- File: plan §R9 mitigation; `src/lib/audit/audit.ts` exports
- Evidence: Plan says "Use `logAudit` (sync, transactional)". The module exports `logAuditAsync`, `logAuditBulkAsync`, `logAuditInTx` — NO `logAudit`. `logAuditInTx` requires real tenantId. `enqueueAuditInTx` opens its own tx + tenant-existence check.
- Problem: Plan cites a function that does not exist. The R9 atomicity-rollback test is unimplementable as written.
- Fix: Adopt `enqueueAuditInTx(tx, SYSTEM_TENANT_ID, payload)` — works once F2 sentinel-tenant is in place. Tx wraps DELETE + audit-enqueue. Test: simulate post-DELETE audit failure; assert DELETE rolled back.

### F5 [Major]: check-bypass-rls.mjs needs ADD, not REMOVE

- File: `scripts/checks/check-bypass-rls.mjs:100`
- Evidence: Allowlist currently includes the route file. Plan says "Add no new entry — the worker uses Prisma without withBypassRls."
- Problem: Worker (per F3 fix) uses bypass GUC. The new file `src/workers/dcr-cleanup-worker.ts` needs an allowlist entry, OR the script must be configured to detect raw-SQL `set_config` differently from `withBypassRls()` (already the case for audit-outbox-worker.ts which is NOT allowlisted — verify the script's detection logic).
- Fix: After implementation, run `bash scripts/pre-pr.sh`. If the bypass-rls check fails citing the new worker file, add it to the allowlist with comment explaining DCR cleanup operates on `tenant_id IS NULL` rows by design. If the script doesn't trip (raw `set_config` pattern), no change needed.

### F6 [Major]: File enumeration omits 5+ files

- File: plan file table
- Evidence (omissions found via grep):
  - `docs/operations/audit-log-reference.md:366` — `MCP_CLIENT_DCR_CLEANUP` row (TENANT scope, metadata=`{ deleted }` → `{ purgedCount, triggeredBy, ... }`)
  - `messages/en/AuditLog.json:191` and `messages/ja/AuditLog.json:191` — actor wording for `MCP_CLIENT_DCR_CLEANUP`
  - `scripts/env-allowlist.ts` — add `DCR_CLEANUP_*` entries
  - `scripts/env-descriptions.ts` — add descriptions
- Fix: Add to plan's "files changed" table and Implementation Checklist.

### F7 [Major]: Tenant audit-logs UI filter excludes SYSTEM scope — silent observability regression

- File: `src/app/api/tenant/audit-logs/route.ts:71`
- Evidence: Route filter is `where.scope = { in: [TENANT, TEAM] }`. Currently `MCP_CLIENT_DCR_CLEANUP` rows are visible (HUMAN actor + TENANT scope). After plan's design (if going with SYSTEM scope OR sentinel tenant), tenant admins lose visibility.
- Problem: With sentinel tenant approach, the audit row's tenantId is `SYSTEM_TENANT_ID` — no real tenant admin sees their own tenant's column matching it. So tenant admins lose the previous visibility into "did the DCR cleanup happen?"
- Fix: Acceptable. The action is system-internal GC; per-tenant visibility was misleading anyway (since the deletion never affected their tenant's data — DCR clients with `tenant_id IS NULL` are unowned). Document in plan: "tenant admins no longer see this in their audit-logs; deliberate — the action does not affect their tenant's data."

### F9 [Major]: Worker DB pool / Prisma instance pattern not specified

- File: `src/workers/audit-outbox-worker.ts:914-927`, plan pseudo-code
- Evidence: audit-outbox-worker creates its own `pg.Pool` from `OUTBOX_WORKER_DATABASE_URL`, instantiates a separate `PrismaClient`, and uses raw `tx.$executeRaw\`SELECT set_config(...)\`` inside `workerPrisma.$transaction(...)`. Importantly, it does NOT use `withBypassRls()` (which targets the app pool).
- Problem: Plan's pseudo-code mentions Prisma usage abstractly. Implementer might reuse `@/lib/prisma` (app pool) instead — silently bypassing the new worker role and connecting as `passwd_app`.
- Fix: Plan must explicitly state: "Worker constructs its own pg.Pool from `DCR_CLEANUP_DATABASE_URL`, instantiates a separate PrismaClient, uses raw `SELECT set_config('app.bypass_rls','on',true)` inside `workerPrisma.$transaction(async tx => ...)`. Do NOT import `@/lib/tenant-rls` or `@/lib/prisma`."

### F8 [Minor]: incident-runbook.md verification status unclear

- Evidence: `grep -n dcr-cleanup docs/operations/incident-runbook.md` returns no matches.
- Fix: Mark in checklist as "verified — no change required".

### F10 [Minor]: docker-compose `depends_on.migrate` needs `required: false`

- Evidence: `docker-compose.override.yml:34-41` audit-outbox-worker uses `condition: service_completed_successfully` + `required: false` (migrate is profile-gated).
- Fix: Plan checklist note: mirror this.

### F11 [Minor]: --validate-env-only test contract reference vague

- Evidence: Plan says "byte-exact env-validation contract test (mirrors outbox env test)" but doesn't enumerate cases.
- Fix: Cross-reference `scripts/__tests__/audit-outbox-worker-env.test.mjs` and enumerate cases (see T13 below).

## Security Findings

### S1 [Critical, escalate=true]: SYSTEM-scope audit cannot be persisted — collapses central security goal

- (Same root cause as F1+F2.) Plan's headline improvement is "turn privileged HUMAN-attributed deletion into durably audited SYSTEM-attributed one". Without working audit emission, this fails — deletions become **invisible** post-merge.
- escalate_reason: The plan as written would merge a regression where a privileged operation produces zero audit signal. Forensic detection of attacker tampering with the worker becomes impossible.
- Fix: Same as F1/F2 — sentinel tenant + scope=TENANT.

### S2 [Critical, escalate=true]: "no BYPASSRLS" privilege boundary claim is unenforceable

- (Same root cause as F3.) Plan claims worker is more isolated than the old route. Reality: worker MUST set `app.bypass_rls='on'` to reach `tenant_id IS NULL` rows; with that GUC set, the privilege boundary is the WHERE filter in code — same footgun as before.
- escalate_reason: Architectural justification of the entire PR rests on a privilege boundary that doesn't exist as described.
- Fix: Same as F3 — explicit honest documentation. The actual privilege improvement is real but more nuanced:
  - Token surface: many op_* tokens (tenant admin convenience) → 1 worker DB password (ops-controlled rotation)
  - Threat vector: tenant admin compromise (medium probability) → infra-team k8s secret leak (lower probability)
  - Audit attribution: HUMAN with misleading tenant attribution → SYSTEM with sentinel tenant attribution (forensically unambiguous)

### S3 [Major]: enqueueAuditInTx tenants-FK existence guard rejects SYSTEM payload

- (Same root cause as F2.) Resolved by sentinel tenant approach.

### S4 [Major]: Atomicity strategy contradictory — fire-and-forget vs in-tx

- (Same root cause as F4.) Resolved by `enqueueAuditInTx(tx, SYSTEM_TENANT_ID, payload)` once sentinel exists.

### S5 [Major]: API removal has no deprecation window

- File: plan §implementation step 12
- Evidence: Plan deletes the route immediately. Operators may have cron jobs calling the endpoint with op_* tokens. Post-upgrade, calls return 404 — many monitors treat 404 as harmless.
- Fix: Replace `route.ts` with a 410 Gone stub for one minor version. Stub returns `{ error: "endpoint_removed", replacement: "worker:dcr-cleanup" }` and emits an audit event (action `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL`) so operators discover stale cron jobs via existing audit pipeline. Delete in following release. Add release-notes line.

### S6 [Major]: Worker password bootstrap secret-handling not specified

- File: plan §user scenarios #2
- Evidence: Plan shows `kubectl exec ... -- bash -c "PASSWD_DCR_..._PASSWORD=... bash scripts/set-..."` — secret lands in shell history, kubectl audit logs, `ps` output.
- Fix: Mirror outbox bootstrap fix: read password from stdin or mounted secret file. Apply the same fix to outbox docs in this PR (since they share the bad pattern). Test: integration test with auth-fail-on-first-connect produces a single structured log line WITHOUT the connection string in error output.

### S7 [Minor]: TOCTOU race on consent-Allow vs sweeper

- File: `src/app/api/mcp/authorize/consent/route.ts:122-129`
- Evidence: Claim CAS does not check `dcrExpiresAt`. With more frequent sweeper, the race window is larger.
- Impact: UX regression — legitimate user gets `already_claimed` when row was actually swept.
- Fix: Out of scope for this PR; track follow-up. Plan should note the relationship between sweep interval and `MCP_DCR_UNCLAIMED_EXPIRY_SEC`.

### S8 [Minor]: Heartbeat audit emission inflates audit volume

- (Same root cause as T6.) Resolved by env knob `DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT` (default `false`).

### S10 [Minor]: Audit action group misclassification affects webhook fan-out

- (Same root cause as T4 + F7.) `MCP_CLIENT_DCR_CLEANUP` is in `AUDIT_ACTION_GROUPS_TENANT[MCP_CLIENT]` (not ADMIN as plan claimed). With sentinel-tenant approach, no real tenant subscribers receive the event — that's intentional and correct.

## Adjacent Findings

### S9-A [Adjacent / Pre-existing]: Audit forgery risk — non-worker can write SYSTEM payloads

- File: `src/lib/audit/audit-outbox.ts:41-46`
- Evidence: No validation that writing role's identity matches `payload.actorType`. Any code path with bypass-RLS + INSERT on audit_outbox can craft `actorType=SYSTEM` rows.
- Routing target: Security expert (re-evaluate as separate PR / tracking issue).
- Pre-existing — not introduced by this plan. Plan inherits it as the first SYSTEM-scope producer.
- Fix: Out of scope. Track separately. Plan should note as inherited concern.

## Testing Findings

### T1 [Critical]: Audit emission silently dead-letters in unit AND production

- (Same root cause as F1+F2+S1.) Resolved by sentinel-tenant + scope=TENANT.

### T2 [Critical]: Integration test helpers don't support new role

- File: `src/__tests__/db-integration/helpers.ts:16-41,50-60`
- Evidence: `createPrismaForRole()` accepts only `"superuser" | "app" | "worker"`. `TestContext` returns `{ su, app, worker }`.
- Problem: Plan's role-grant integration tests are unimplementable — cannot connect as `passwd_dcr_cleanup_worker`.
- Fix: Add explicit prerequisite step before implementation: extend `helpers.ts` with `dcrWorker` role + `DCR_CLEANUP_DATABASE_URL` env var.

### T3 [Critical]: Plan misnames in-tx audit helper (`logAudit` vs `logAuditInTx`)

- (Same root cause as F4.) Already covered.

### T4 [Critical]: Plan misstates audit-action group membership

- File: `src/lib/constants/audit/audit.ts:577-588`
- Evidence: `MCP_CLIENT_DCR_CLEANUP` is in `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.MCP_CLIENT]`, not `[ADMIN]` as the plan asserts.
- Fix: Update plan references. With sentinel-tenant approach, group placement remains MCP_CLIENT (correct as-is).

### T5 [Major]: Single-flight test design is vacuous

- File: plan §testing strategy
- Evidence: Loop shape `while { await sweep; await sleep; }` has zero overlap risk by construction. Tested via fake-timers, the assertion either passes vacuously or hangs.
- Fix: Drop the single-flight test. Replace with structural code comment in worker explaining why overlap is impossible.

### T6 [Major]: Heartbeat audit emit at count=0 has no test pinning the contract

- File: plan §audit emission
- Evidence: Plan emits audit even when count=0. No test asserts intended behavior; future refactor `if (count===0) return` would silently break it.
- Fix: Add env knob `DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT` (default `false` — quiet by default; set `true` if observability requires heartbeat). Test both paths.

### T7 [Major]: Mock return shape for raw SQL DELETE unspecified

- File: plan §loop shape
- Evidence: Plan doesn't pin `$executeRawUnsafe` (returns `Promise<number>`) vs `$queryRawUnsafe` (returns `Promise<unknown[]>`).
- Fix: Pin `$executeRawUnsafe` (returns count). Unit test mocks return number; assert `metadata.purgedCount === N`.

### T8 [Major]: systemAuditBase mock-coverage gap

- (Same root cause as F1.) Drop `systemAuditBase` helper entirely; use existing `tenantAuditBase(req, userId, SYSTEM_TENANT_ID)` from worker context (req absent — adapt) OR build the payload inline. The mock-coverage issue evaporates.
- Fix: Replace `systemAuditBase` with inline payload construction. Document expected mock approach (importOriginal spread for audit module).

### T9 [Major]: Coverage migration table missing

- File: `src/app/api/maintenance/dcr-cleanup/route.test.ts:97-205`
- Evidence: 7 deleted route test cases. Plan doesn't map them to new tests.
- Fix: Add coverage migration table:
  | Old test | New location |
  |---|---|
  | 401 unauth | N/A — endpoint removed (covered by 410 stub test instead) |
  | 401 invalid token | Same |
  | 429 rate limit | N/A — worker has no rate limit |
  | 401-before-429 ordering | N/A |
  | 400 not admin | N/A |
  | 200 deletes-N | `dcr-cleanup-worker.test.ts: sweepOnce returns N` |
  | 200 deletes-0 + heartbeat | `sweepOnce + emitHeartbeatAudit=true/false toggle test` |
  | audit shape strict (no operatorId/authPath) | `audit shape strict (no operatorId/tokenId/tokenSubjectUserId/systemWide leakage)` |

### T10 [Major]: `sleepWithAbort` invented with no implementation locus

- File: plan pseudocode
- Evidence: `grep sleepWithAbort src/` returns nothing. Plan invents the primitive.
- Fix: Use `import { setTimeout as setTimeoutPromise } from 'node:timers/promises'` — accepts AbortSignal natively, plays well with `vi.useFakeTimers()`. Drop the invented helper.

### T11 [Minor]: Plan doesn't mandate import of AUDIT_ACTION constants

- Fix: Plan must require `import { AUDIT_ACTION } from "@/lib/constants/audit/audit"; expect(...).toBe(AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP)` not literal string.

### T12 [Minor]: Integration test seed misses 3 boundary combinations

- Fix: Seed all 8 combinations of (is_dcr × tenant_id × dcr_expires_at) in sweep test — at minimum add (a) is_dcr=false + tenantId=null + expired (proves is_dcr filter is load-bearing), (b) is_dcr=true + tenantId=null + dcr_expires_at = exact now() (proves strict-less-than).

### T13 [Minor]: --validate-env-only contract under-specified

- Fix: Plan must enumerate test cases:
  - Valid env exits 0 with `{level:"info",msg:"env validation passed"}`
  - Missing `DCR_CLEANUP_DATABASE_URL` exits 1
  - Malformed URL exits 1
  - `DCR_CLEANUP_INTERVAL_MS` below 60_000 exits 1
  - `DCR_CLEANUP_BATCH_SIZE` above 10_000 exits 1

## Quality Warnings

None — all findings include evidence and specific fix recommendations.

## Recurring Issue Check

### Functionality expert

- R1 (Requirements coverage): F1, F2, F3, F7 — central audit emission unworkable
- R2 (Architecture coherence): F3, F9 — bypass-rls strategy inconsistent
- R3 (File enumeration): F6 — multiple omissions
- R4 (Schema/migration consistency): F2 — NOT NULL violations
- R5 (Atomic operation strategy): F4 — claimed helper missing
- R6 (Process model fidelity): F9 — own pool / own Prisma not specified
- R7 (Env vars / dotenv): N/A — naming consistent
- R8 (Signal handling): N/A — plan mirrors outbox
- R9 (Tx-bound audit): F4
- R10 (Single-flight): N/A — covered by T5
- R11 (Logger call sites): N/A — keys consistent
- R12 (Audit action groups): F7, T4
- R13 (Migration ordering): F10
- R14 (DB grants): F2, F3
- R15 (current_database): N/A — plan calls out
- R16 (Password bootstrap): N/A — mirrors existing
- R17 (k8s manifest): N/A — mirrors existing
- R18 (check-bypass-rls): F5 — direction wrong
- R19 (Strict-shape assertion): N/A — plan demands it
- R20 (Heartbeat zero-row): N/A — covered by T6
- R21 (Test seed coverage): N/A — covered by T12
- R22 (No --no-verify): N/A
- R23 (i18n): F6
- R24 (Test framework): N/A — vitest
- R25 (Build verify): N/A — pre-pr.sh
- R26 (Webhook impact): F1+F7 — SYSTEM scope no fan-out
- R27 (Mocks vs integration): N/A — plan distinguishes
- R28 (Doc drift): F6
- R29 (Implementation step ordering): N/A — Step 12 after Step 4
- R30 (Cleanup deleted-route mocks): F6

### Security expert

- R1: N/A
- R2: N/A
- R3: out-of-scope re-confirmed
- R4: N/A
- R5: S4 (= F4)
- R6: N/A
- R7: N/A
- R8: N/A
- R9: S4 (= F4)
- R10: N/A
- R11: N/A
- R12: S10 (= F7+T4)
- R13: N/A
- R14: S2, S3 (= F3, F2)
- R15: OK
- R16: N/A
- R17: N/A
- R18: OK (plan removes deleted route's entry; F5 covers worker entry direction)
- R19: OK
- R20: N/A
- R21: N/A
- R22: N/A
- R23: N/A
- R24: N/A
- R25: S5 — no deprecation window
- R26: N/A
- R27: N/A
- R28: N/A
- R29: OK — only RFC 7591 passing reference
- R30: OK
- RS1: N/A — no token compare
- RS2: N/A — no new endpoint with rate limit
- RS3: Partial — env URL validation; T13 enumerates

### Testing expert

- R1-R30: see Testing Findings (T1-T13)
- R9: T3
- R12: T4
- R14: T6
- R18: OK
- R19: T8 (resolved by dropping helper)
- RT1: T7 — mock-reality divergence
- RT2: T2 — helpers don't support new role
- RT3: T11 — import constant vs string

---

## Round 2

All 11 Round 1 findings RESOLVED. 19 new findings introduced by v2 plan, all addressed in v3:

### Functionality (Round 2 → v3 resolution)

- **F12 [Critical]** `acceptLanguage` not in `AuditOutboxPayload` → v3 §"Audit emission shape" rewritten to match `audit-outbox.ts:6-18` interface exactly (fields enumerated: `scope, action, userId, actorType, serviceAccountId, teamId, targetType, targetId, metadata, ip, userAgent`).
- **F13 [Major]** Missing 4 nullable fields → resolved with F12.
- **F14 [Major]** check-bypass-rls allowlist drift → v3 specifies updating the existing entry from `["mcpClient"]` to `[]`.
- **F15 [Major]** Sentinel chain growth claim → v3 §considerations promotes the claim with explicit chain anchor mechanism.
- **F16 [Major]** Tenant-enumerating callers / sentinel exposure → v3 §considerations adds slug uniqueness + tenant.findMany note.
- **F17 [Minor]** Webhook fan-out for sentinel → v3 §considerations explicit "no need to add to WEBHOOK_DISPATCH_SUPPRESS".
- **F18 [Minor]** Audit emit before/after rate limit → v3 §410 stub flow specifies AFTER rate-limit (preserves legacy ordering, prevents flooding).
- **F19 [Minor]** Stale "optional audit-outbox.ts change" → v3 changed to "Verified — no change".

### Security (Round 2 → v3 resolution)

- **S11 [Minor]** 410-stub audit metadata shape → v3 §"410 deprecation-stub audit emission shape" pins the shape (PRESENT: tokenSubjectUserId, tokenId, deprecated, replacement; ABSENT: purgedCount, triggeredBy, sweepIntervalMs, systemWide).
- **S12 [Minor]** Worker DB credential blast-radius vs op_* token → v3 §honest-framing table adds DoS reach row.
- **S13 [Minor]** Migration must NOT create tenant_members for sentinel → v3 §migration entry explicit "Migration creates ONLY the tenants row".
- **S14 [Minor]** pg error-shape contract → v3 §considerations pins log to `{level, msg, code}` only; explicit test asserts `localhost:5432` not in stderr.
- **S15 [out-of-scope, note only]** Heartbeat-knob env-change audit trail → v3 §considerations adds 1-line note.

### Testing (Round 2 → v3 resolution)

- **T9 [Major, partially]** Coverage migration table — 401 unauth row was incorrect → v3 rewrites the table: 401/429/400 paths PRESERVED; success status changes 200→410. Adds new strict-shape row for 410 stub.
- **T12 [Minor, needs-followup]** 8 vs 12 boundary math → v3 §sweep test specifies 9 rows: 2³ binary axes (8) + 1 boundary row at exact `now()`.
- **T14 [Major]** tx-rollback simulation strategy → v3 §"tx-rollback test" pins: in-process call to `sweepOnce`, `vi.mock(@/lib/audit/audit-outbox, async (importOriginal) => ({ ...real, enqueueAuditInTx: rejected }))`. Drops the "DELETE sentinel" alternative.
- **T15 [Major]** 410 stub auth flow ordering → v3 §"410 deprecation-stub audit emission shape" pins flow: verifyAdminToken → rate-limit → requireMaintenanceOperator → audit emit → return 410. Legacy 401/429/400 paths PRESERVED.
- **T16 [Major]** Strict-shape ABSENCE list for 410 stub audit → resolved with S11 (PRESENT/ABSENT lists pinned).
- **T17 [Major]** helpers.ts extension API surface → v3 §file table specifies env var name `DCR_CLEANUP_DATABASE_URL`, fallback substitution `passwd_dcr_cleanup_worker:passwd_dcr_pass`, CI workflow file inclusion.
- **T18 [Minor]** Audit chain anchoring for sentinel coverage gap → v3 §sweep test adds assertion `audit_chain_anchors` row for `SYSTEM_TENANT_ID` after outbox-worker drains.
- **T19 [Minor]** Pre-existing outbox bootstrap fix has no test → v3 §"Bootstrap script tests" adds `scripts/__tests__/set-{dcr-cleanup,outbox}-worker-password.test.mjs`. Implementation Checklist updated.
- **T20 [Minor]** --validate-env-only contract `received` not echoed claim unimplementable → v3 §contract reworded: assert structural fields only; separate worker-startup test covers pg auth-fail log shape.

### Status

All Round 2 findings have a concrete v3 resolution. Awaiting Round 3 verification.

---

## Round 3 + v4

### Functionality
- F12-F19: all RESOLVED in v3 (verified Round 3).
- New Round 3 findings (all Minor):
  - **F20**: DoS-reach mitigation note → v4 §"Known limitations" adds explicit accepted-risk statement + defense-in-depth follow-up.
  - **F21**: "exact now()" boundary row precision → v4 §sweep test refined: `$now_at_seed = SELECT now()` captured immediately before seeding.
  - **F22**: Internal consistency check passed (no edit needed).

### Security
- S11-S15: all RESOLVED in v3.
- New Round 3 findings (all Minor):
  - **S16**: in-loop `log.error({err})` leak risk → v4 §loop shape pinned to `{ code }` only.
  - **S17**: chain-anchor cross-worker timing race → addressed with T24 (in-process `deliverRowWithChain` invocation).
  - **S18**: defense-in-depth DB constraint → v4 §"Known limitations" explicit accepted risk + follow-up.
  - **S19**: sentinel chain forensic gap → v4 §"Known limitations" promotes from out-of-scope.

### Testing
- T9, T12, T15+T16, T17: RESOLVED in v3.
- T19/T20: PARTIALLY in v3 → fully addressed in v4.
- New Round 3 findings:
  - **T21 [Minor]**: vi.mock vs audit-outbox-atomicity precedent → v4 adds 1-sentence rationale.
  - **T22 [Major, blocker]**: PATH shadow not implementable → v4 replaces with `DRY_RUN=1 + --print-args-file <tmpfile>` pattern. Both `set-dcr-cleanup-worker-password.sh` AND `set-outbox-worker-password.sh` (S6 fix) gain this flag.
  - **T23 [Minor]**: `localhost:5432` substring assertion fragile → v4 replaces with regex anchor `^\{"level":"error","msg":"db auth failed","code":"[A-Z0-9_]+"\}$`.
  - **T24 [Minor]**: chain-anchor drain dependency unclear → v4 §sweep test pins in-process `deliverRowWithChain` invocation, no subprocess.

### Phase 1 termination decision

User opted to skip Round 4 verification and proceed to Step 1-7 (branch + commit).

Justification (per Anti-Deferral Rules):
- All Round 1+2 findings RESOLVED.
- Round 3 had 1 Major (T22) which is RESOLVED in v4. Remaining 9 Minor items are spec-clarity refinements all addressed in v4 except F22 (which was already verified).
- No architectural concerns introduced by v4 deltas (mechanical text edits to add precision).
- Plan reaches implementation-ready detail: Implementation Checklist enumerated, atomicity strategy concrete, test infrastructure paths pinned, DB role grants enumerated.
- Phase 2 (implementation) sub-agents can detect remaining clarity issues at coding time and add to deviation log.

This is **NOT** an "Acceptable risk" deferral — it is a "spec is ready, implementation phase will surface any residual concerns" decision. Cost-to-fix any v4 clarity gap during implementation: low (~5 min text edit per gap, with concrete file/line references already in v4).
