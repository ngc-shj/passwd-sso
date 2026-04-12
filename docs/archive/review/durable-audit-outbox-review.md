# Plan Review: durable-audit-outbox

Date: 2026-04-12T12:00:00+09:00
Review round: 3 (final)

## Changes from Previous Round

Initial review.

## Functionality Findings

### [F1] Critical: logAudit synchronous tenantId resolution is impossible — spec contradiction

Plan section 1.4 says payload construction happens synchronously before FIFO enqueue AND that tenantId resolution requires a `withBypassRls` DB lookup. A DB round-trip cannot occur synchronously in a void function. The plan must clarify: either the FIFO holds unresolved entries and the flusher resolves asynchronously per-entry, or callers must pass tenantId.

### [F2] Major: enqueueAudit() non-tx wrapper is not atomic with caller's existing prisma.$transaction

`withBypassRls` always opens its own `$transaction`. Call sites currently inside `prisma.$transaction` that use `logAudit`/`enqueueAudit` silently break atomicity (the enqueue can succeed even if the business tx rolls back). Plan must document this contract, add a runtime warning when `getTenantRlsContext()` is already set, and inventory inside-tx call sites for Phase 1 migration to `logAuditInTx`.

### [F3/S6] Major: enqueueAuditInTx runtime GUC guard lets cross-tenant writes through under withBypassRls

Guard logic `if (bypass_rls !== "on" && tenant_id !== tenantId)` short-circuits on bypass — a wrong `tenantId` under `withBypassRls` is not caught. Cross-tenant audit misattribution. Fix: add a `tenantId` existence check (`SELECT 1 FROM tenants WHERE id = $1`) and document the bypass trust boundary.

### [F4] Major: process.beforeExit + setInterval(250ms) flush design fails under k8s SIGTERM

`beforeExit` never fires on SIGTERM; `setInterval` (unref missing) blocks graceful shutdown. Plan must add `.unref()`, explicit SIGTERM/SIGINT handler, and document ordering vs. Next.js shutdown.

### [F5] Major: F10 "187 call sites unchanged" contradicts R-PHASE1-1 durability caveat

F10 implies durability; R-PHASE1-1 concedes 187 call sites do NOT deliver F1. Restate F10 as source-compatibility only; produce the call-site inventory as Phase 1 deliverable.

### [F6] Major: Flusher per-entry vs per-batch failure semantics undefined

When tenantId resolution fails for one entry in a batch, does it drop that entry or the whole batch? Specify: per-entry dead-letter on resolution failure; batch-level DB error keeps entries in FIFO.

### [F7] Major: Worker claim tx boundaries + post-commit webhook dispatch under-specified

Explicitly state: claim SQL + audit_logs insert + outbox SENT UPDATE run in one tx; webhook dispatch runs after the tx commits.

### [F8/S10] Major: Worker must catch P2002 on outboxId unique-constraint hit explicitly

Without explicit `catch (P2002)` or `ON CONFLICT DO NOTHING`, the worker may falsely dead-letter already-delivered rows. Add explicit error mapping in the worker code sketch and specify the dedup mechanism (recommended: `INSERT ... ON CONFLICT (outbox_id) DO NOTHING` raw SQL).

### [F9] Major: AuditChainAnchor onDelete: Cascade contradicts AuditLog onDelete: Restrict

`audit_logs → tenant` is Restrict, so tenant deletion is already blocked. Cascade comment describes a scenario that cannot occur. Change anchor to Restrict for consistency.

### [F10] Major: Section 2.1 checklist omits AUDIT_ACTION_GROUPS_PERSONAL and _TEAM

Three group containers exist (PERSONAL / TEAM / TENANT). Plan only mentions TENANT. Extend checklist + add "MUST NOT appear in PERSONAL/TEAM" note.

### [F11] Major: passwd_outbox_worker password rollout has no concrete mechanism for prod

Initdb only runs on fresh volumes; migration creates role without password. Provide a concrete step (e.g., `scripts/set-outbox-worker-password.sh`).

### [F12] Major: "Outbox is the only persistent path post-Phase-2" is subtly false

Worker writes `AUDIT_OUTBOX_*` meta-events directly to `audit_logs`. Restate F1 to carve out worker meta-events as the one documented exception; add a test that only `AUDIT_OUTBOX_*` actions can have NULL `outboxId`.

### [F13] Minor: N1 "≥1000 events/sec" needs OUTBOX_BATCH_SIZE default specified

At batch_size=100 + 1s poll, N1 is unachievable. Add explicit OUTBOX_BATCH_SIZE (default 500) to the AUDIT_OUTBOX namespace.

### [F14] Minor: Raw SQL / Prisma type interop not specified for worker RETURNING *

Worker hand-declares `AuditOutboxRow` to match raw SQL columns. Add one sentence.

### [F15] Minor: Audit event-time drift under worker backlog

Worker should copy `audit_outbox.created_at` into `audit_logs.created_at` explicitly, not use `now()`.

### [F16] Minor: Moving webhook dispatch to worker changes source IP (Phase 1 blast radius)

Consider deferring webhook-dispatch move to Phase 3 when `audit_deliveries` exists.

### [F17] Minor: Reaper last_error concatenation grows unboundedly

Replace instead of concatenate; cap at 1024 chars (merged with S17).

## Security Findings

### [S1-confirmed] Critical: Worker lacks DELETE grant on audit_outbox — reaper purge fails (Opus confirmed)

Plan section 1.2 grants only SELECT, UPDATE; section 2.2 reaper issues DELETE. Worker will get `permission denied` on every reaper cycle. TM10 mitigation is completely broken. Fix: add `GRANT DELETE`; optionally restrict DELETE to `status IN ('SENT','FAILED')` via trigger. Integration test must verify both positive (CAN delete SENT/FAILED) and negative (CANNOT delete PENDING).

### [S2-refined] Critical: Phase 3 deliverers skip PII filtering — WEBHOOK_METADATA_BLOCKLIST (Opus refined)

Phase 1 webhook path is safe IF it reuses `dispatchWebhook`/`dispatchTenantWebhook` (which sanitize internally). Phase 3 SIEM_HEC and S3_OBJECT are net-new code with no PII filter. N5 misleads by saying "Worker delivery does not need to re-sanitize." Fix: remove misleading N5 statement; extract `sanitizeForExternalDelivery` alongside `EXTERNAL_DELIVERY_METADATA_BLOCKLIST`; all external deliverers must call it before outbound HTTP. Integration test: event with all 22 blocklisted keys → none appear in outbound payloads.

### [S3] Major: Phase 3 tables (audit_delivery_targets, audit_deliveries) lack RLS policies

New multi-tenant tables without RLS violate the FORCE-RLS migration convention. `audit_deliveries` needs a denormalized `tenant_id` for a cheap policy. Fix: add ENABLE/FORCE RLS + tenant_isolation policy in Phase 3 migration.

### [S4] Major: Phase 3 migration omits worker-role grants for new delivery tables

Worker needs `SELECT ON audit_delivery_targets` and `SELECT, INSERT, UPDATE, DELETE ON audit_deliveries`. Without grants, fan-out silently fails — SIEM/S3 durability guarantee broken.

### [S5] Major: AWS SDK S3/SIEM delivery bypasses pinned-dispatcher SSRF defense

AWS SDK does its own DNS resolution, bypassing `resolveAndValidateIps` + `createPinnedDispatcher`. Custom S3 endpoints enable DNS rebinding to internal services. Fix: build and sign PUT requests manually with the pinned dispatcher, do NOT use vendor SDKs for arbitrary user-provided endpoints.

### [S7] Major: passwd_outbox_worker retains USAGE, SELECT ON ALL SEQUENCES — not least privilege

UUID PKs don't need sequences. Remove the sequence grant entirely.

### [S8] Major: Pre-outbox RAM buffer preserves silent-loss property on legacy path

For 187 call sites that don't use `logAuditInTx`, loss surface is unchanged from today. Mark `logAudit` as `@deprecated` with explicit JSDoc; migrate `CREDENTIAL_ACCESS` / `VAULT_UNLOCK` / `SHARE_LINK_ACCESSED` groups to `logAuditInTx` in Phase 1 itself.

### [S9] Minor: Worker-written SYSTEM events violate audit_logs.userId NOT NULL FK

`audit_logs.user_id` is NOT NULL UUID with FK to `users`. Worker has no User row. Fix: make `userId String? @db.Uuid` when `actorType = SYSTEM` with CHECK constraint, OR seed a SYSTEM user per tenant.

### [S11] Minor: Purge endpoint spec under-specifies auth envelope

Add explicit `verifyAdminToken` + `createRateLimiter` + operator membership check + Zod validation + audit log for the purge-failed endpoint.

### [S12] Minor: Worker claim SQL lacks explicit re-assertion of status='PENDING' on outer UPDATE

Add `AND status = 'PENDING'` in the outer WHERE clause.

### [S13] Minor (Major if enabled): chain_seq is ingestion order not event order

Document explicitly that chain_seq represents ingestion order, not event order. Add `created_at` monotonicity check to verify endpoint.

### [S15] Major (Opus new): process.beforeExit flusher inherits stale AsyncLocalStorage tenant context

`beforeExit` runs in the same event loop as the current request. Flusher's `withBypassRls` may inherit outer tenant context causing cross-tenant misattribution. Fix: wrap flusher in `tenantRlsStorage.run(undefined, async () => { ... })`.

### [S16] Major (Opus new): Phase 1-to-2 deploy ordering creates transient R13 re-entrant loop

Phase 1 ships webhook dispatch in worker but Phase 2 introduces `OUTBOX_BYPASS_AUDIT_ACTIONS`. During rolling deploy, old worker code enqueues meta-events. Fix: Phase 1 worker MUST include the `OUTBOX_BYPASS_AUDIT_ACTIONS` set (empty, but the bypass logic wired in), merged with T10.

### [S17] Major (Opus new): lastError stores unbounded attacker-controlled response bodies

`@db.Text` has no limit. Cap at 1024 chars; never store raw response bodies; use `@db.VarChar(1024)` or app-level truncation.

### [S18] Minor (Opus new): Metrics endpoint reveals cross-tenant aggregate counts

Document as known exposure for infrastructure operators only.

### [S19] Minor (Opus new): Hash chain does not protect against worker-compromise reordering

Document in TM2/TM5 that chain does NOT protect against compromised-worker reordering. Include `created_at` in canonical hash input.

## Testing Findings

### [T1] Critical: No test for logAudit non-atomicity on the legacy void path

Phase 1 plan only tests `logAuditInTx` atomicity but never proves the known limitation of the void shim. Add negative test: `logAudit` inside `prisma.$transaction(... throw)` → audit row IS still enqueued (proving non-atomicity). Both tests must exist from Phase 1.

### [T2] Critical: "Reuse dev docker-compose stack" does not work in CI as specified

`migrate` service uses `profiles: ["migrate"]` (not auto-started); `db` doesn't publish port 5432 in base compose; CI uses GitHub Actions services, not docker-compose. Fix: align with existing CI `rls-smoke` pattern — GitHub Actions postgres service + role creation via psql + `prisma migrate deploy`.

### [T3] Critical: Mock-reality divergence between updated audit.test.ts and real outbox path (RT1)

After rewrite, `logAudit` no longer calls `prisma.auditLog.create`; it calls `enqueueAudit` which writes `auditOutbox.create`. The flusher is `setImmediate`-based which the existing `flushAsyncWork()` helper won't drain reliably. Fix: narrow `audit.test.ts` to pure-function coverage; move "writes an audit row" assertions to real-DB integration tests.

### [T4] Critical: Proposed vitest.integration.config.ts conflicts with existing vitest.config.ts

Existing config includes all `src/**/*.test.{ts,tsx}` — integration tests would run (and fail) in the unit test job. Fix: add `exclude: ["src/**/*.integration.test.ts"]` to existing config; normalize all real-DB test file names to `.integration.test.ts`; place under `src/__tests__/db-integration/`.

### [T5] Major: audit-outbox-skip-locked.integration.test.ts cannot simulate concurrent workers from one process

Requires TWO Prisma clients with separate pools. Test must use explicit `$executeRawUnsafe("BEGIN")` and a Deferred barrier. Alternatively: SQL script mirroring `scripts/rls-smoke-verify.sql`.

### [T6] Major: Pre-outbox flusher crash-loss surface not tested

Missing tests for `process.beforeExit` flush, flusher reentrance, retry counter, time-based flush. Expand test to use `vi.useFakeTimers()` + `process.emit('beforeExit')`.

### [T7] Major: audit-outbox-rls.integration.test.ts does not verify FORCE RLS

Add test connecting as `passwd_user` (table owner) without bypass GUC, assert SELECT returns 0 for other tenant's rows.

### [T8] Major: audit-outbox-worker-role test does not test ALL table-level denies

Spot-checking 2 tables can't detect broad grants. Query `information_schema.table_privileges WHERE grantee = 'passwd_outbox_worker'` and assert exact allowed set.

### [T9] Major: audit-outbox-dedup test doesn't specify the dedup mechanism

Specify: `INSERT ... ON CONFLICT (outbox_id) DO NOTHING` raw SQL. Test 3 cases: (a) new row, (b) existing same outboxId → no-op + SENT, (c) different outboxId → normal insert.

### [T10/S16] Major: No test for R13 re-entrant suppression in Phase 1

Phase 1 ships webhook dispatch in worker but `OUTBOX_BYPASS_AUDIT_ACTIONS` is Phase 2. Move bypass set + logic to Phase 1; add integration test that webhook delivery failure → audit event written directly to `audit_logs`, NOT as new outbox row.

### [T11] Major: audit-action-groups.test.ts may duplicate existing src/lib/constants/audit.test.ts

Verified existing file exists. Amend plan: "extend `src/lib/constants/audit.test.ts`" only.

### [T12] Major: audit-outbox-metrics-endpoint.test.ts has no mock-reality anchor for audit action enum (RT3)

Mocked test must import `AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW` from `@/lib/constants/audit`, not use string literals. Add real-DB integration test variant.

### [T13] Major: audit-chain-ordering test depends on unresolved Q7 (RT2)

Resolve Q7: use same two-Prisma-client pattern as T5. No separate harness needed.

### [T14] Major: SSRF helper extraction has no per-CIDR regression test

Use `describe.each` iterating ALL `BLOCKED_CIDRS` entries. After extraction, run BOTH `webhook-dispatcher.test.ts` and new `external-http-ssrf.test.ts`. Import `BLOCKED_CIDRS` from `external-http.ts` in tests (RT3).

### [T15] Major: No per-target rate limiter test for Phase 3 fan-out

Add `audit-delivery-rate-limit.test.ts` asserting deliverer called ≤ max within window.

### [T16] Major: P2-T3 and P2-T4 (test fixture updates) silently dropped from plan

Explicitly resolve: P2-T3 — no tenant policy fields added, fixtures need no update. P2-T4 — out of scope, track as separate follow-up.

### [T17] Minor: Test table ambiguity between "Mocked" and "Real DB"

Annotate hybrid tests as "Real DB + Mocked HTTP" explicitly.

### [T18] Minor: Test assertions should use imported constants not hardcoded values (RT3)

All state-machine tests must import from `@/lib/constants/audit` namespace.

### [T19] Minor: No test for reaper interaction with in-flight workers

Reaper SQL needs `FOR UPDATE SKIP LOCKED`. Add non-interference integration test.

### [T20] Minor: No teardown strategy for integration tests

Each test must generate unique tenant UUID; cascade-delete in `afterEach`. Document chosen isolation strategy.

## Adjacent Findings

### [S14-adj] Minor (routed → Functionality): Plan silently changes stored audit_logs.metadata shape
Today, `audit_logs.metadata` stores unsanitized metadata. The plan applies `sanitizeMetadata` at enqueue time, which is a net-positive security change but a silent behavior change for downstream readers.

### [T8-adj] Major (routed → Security): Worker role privilege enumeration needed
Covered by S7 (sequence grants) and addressed by T8 (complete privilege assertion test).

### [T19-adj] Minor (routed → Functionality): Reaper deadlock risk with worker FOR UPDATE
Covered by F17 fix (cap reaper last_error) + T19 fix (add SKIP LOCKED to reaper).

## Quality Warnings

No findings flagged by merge-findings quality gate.

## Recurring Issue Check

### Functionality expert
- R1: Checked — no issue (backoff + SSRF extractions in plan)
- R2: Checked — addressed (AUDIT_OUTBOX namespace). Finding F13 (missing OUTBOX_BATCH_SIZE)
- R3: Finding F10 — PERSONAL/TEAM group maps missing from checklist
- R4: Checked — no issue
- R5: Finding F2 — enqueueAudit non-tx wrapper not atomic
- R6: Finding F9 — AuditChainAnchor Cascade vs Restrict
- R7: N/A — no UI changes
- R8: N/A — no UI changes
- R9: Checked — enqueueAuditInTx addresses core pattern; F2/F5 cover legacy gap
- R10: Checked — no circular deps (lazy import preserved)
- R11: Checked — MAINTENANCE excluded from subscription group
- R12: Checked — R12 test covered; F10 refines
- R13: Checked — dual suppress sets; F12 notes doc gap

### Security expert
- R1: Finding S2-refined — sanitization not extracted for Phase 3 reuse
- R2: Checked — no issue
- R3: Finding S11 — purge endpoint under-specifies auth envelope
- R4: N/A — no subscribable notifications
- R5: Finding S6 — bypass path doesn't enforce tenant-match
- R6: Checked — no issue
- R7: N/A — no UI changes
- R8: N/A — backend only
- R9: Finding S8 — legacy path retains fire-and-forget to RAM
- R10: Checked — no issue
- R11: Checked — no issue
- R12: Checked — no issue
- R13: Finding S16 — Phase 1→2 deploy ordering creates transient loop
- RS1: Checked — no issue (reuses timingSafeEqual via verifyAdminToken)
- RS2: Finding S11 — purge endpoint less explicit
- RS3: Finding S11 — purge endpoint body validation not specified

### Testing expert
- R1: Checked — backoff + SSRF extraction acknowledged
- R2: Finding T18 (RT3) — test assertions should import constants
- R3: Checked — no issue
- R4: Finding T15 — no rate limiter test for fan-out
- R5: Checked — enqueueAuditInTx requires tx
- R6: N/A
- R7: N/A — no UI changes
- R8: N/A
- R9: Finding T1 — no test proving legacy logAudit non-atomicity
- R10: Checked — no issue
- R11: Checked — MAINTENANCE excluded
- R12: Finding T11 — test duplication risk
- R13: Finding T10 — Phase 1 loop risk window
- RT1: Findings T3, T12 — mock-reality divergence
- RT2: Findings T5, T13 — testability verification
- RT3: Findings T12, T14, T18 — shared constants in tests

---

## Round 2 Results

Date: 2026-04-12
Round 1 findings: Critical 7 / Major 29 / Minor 15 → ALL resolved in plan updates.

### Round 2 Findings (new)

**Functionality (F18–F25)**: 4 Major, 4 Minor
- F18 (Major): enqueueAudit ctx.tx reference error → resolved (refactored to explicit $transaction)
- F19 (Major): worker single-tx rollback contradiction → resolved (2-tx design: claim + deliver)
- F20 (Major): AUDIT_OUTBOX_PURGE_EXECUTED missing from action table → resolved (5th action added + canonical bypass set table)
- F21 (Major): AuditOutboxPayload.userId non-nullable → resolved (userId: string | null)
- F22 (Minor): reaper interval hardcoded → resolved (make_interval with parameter)
- F23 (Minor): retention DELETE SQL injection → resolved (make_interval, no string concat)
- F24 (Minor): negative assertion for MAINTENANCE group → resolved (added to test)
- F25 (Minor): BEFORE DELETE trigger optional → resolved (made mandatory)

**Security (S20–S26)**: 4 Major, 3 Minor
- S20 (Major): trigger mandatory ≈ F25 → resolved (mandatory)
- S21 (Major): SQL interval injection ≈ F23 → resolved (make_interval)
- S22 (Major): payload userId ≈ F21 → resolved
- S23 (Major): PURGE_EXECUTED missing ≈ F20 → resolved
- S24 (Minor): non-null assertion ≈ F18 → resolved
- S25 (Minor): Phase 3 lastError @db.Text → resolved (VarChar(1024))
- S26 (Minor): initdb REVOKE missing → resolved

**Testing (T21–T29)**: 5 Major, 4 Minor
- T21 (Major): bypass coverage test missing → resolved (added to Phase 2 table)
- T22 (Major): bypass set contradiction → resolved (canonical table in §2.1)
- T23 (Major): outboxId NULL invariant test missing → resolved (added)
- T24 (Major): worker role test Phase 3 update → resolved (update note added)
- T25 (Major): purge endpoint test missing → resolved (mocked + integration added)
- T26 (Minor): readiness both conditions → resolved (test amended)
- T27 (Minor): flusher per-entry isolation → resolved (added to flusher test)
- T28 (Minor): SIGTERM timeout test → resolved (added to flusher test)
- T29 (Minor): i18n group label coverage → resolved (added to i18n test)

### Round 2 Summary

All 24 findings resolved. No new Critical findings. Convergence achieved — plan ready for commit.

Total review effort (rounds 1–2): 2 rounds × 3 experts + 1 Opus escalation = 7 expert passes.

---

## Round 3 Results

Date: 2026-04-12
Round 2 findings: Critical 0 / Major 13 / Minor 11 → ALL resolved.

### Round 3 Findings (new)

**Functionality (F26–F29)**: 2 Major, 2 Minor
- F26 (Major): tx2 error recovery rollback → resolved (independent tx3 for error state update)
- F27 (Major): bypass set stale text in 3 places → resolved (aligned §1.6, F11, TM8 with §2.1 canonical table)
- F28 (Minor): REAPER_INTERVAL_MS not in constants list → resolved (added)
- F29 (Minor): "4 actions" → "5 actions" count → resolved (all references updated)

**Security (S27–S32)**: 0 Major, 6 Minor
- S27 (Minor): bypass set text stale ≈ F27 → resolved (same fix)
- S28 (Minor): outboxId NULL invariant needs CHECK constraint → resolved (added to migration)
- S29 (Minor): BEFORE DELETE trigger DDL → resolved (concrete DDL added to plan)
- S30 (Minor): ALTER DEFAULT PRIVILEGES REVOKE → resolved (added to initdb)
- S31 (Minor): Phase 4 audit_chain_anchors RLS → resolved (added to step 25)
- S32 (Minor): audit-chain-verify auth envelope → resolved (full admin envelope specified)

**Testing (T30–T33)**: 2 Major, 2 Minor
- T30 (Major): stale bypass text ≈ F27/S27 → resolved (same fix)
- T31 (Major): BEFORE DELETE trigger test missing → resolved (test added to Phase 2 table)
- T32 (Minor): bypass coverage test missing Phase 1 members → resolved (added to assertion)
- T33 (Minor): retention purge test PROCESSING safety → resolved (assertion added)

### Round 3 Summary

All 14 findings resolved. No Critical findings in rounds 2 or 3 — convergence achieved.

| Round | Critical | Major | Minor | Total |
|-------|----------|-------|-------|-------|
| 1     | 7        | 29    | 15    | 51    |
| 2     | 0        | 13    | 11    | 24    |
| 3     | 0        | 4     | 10    | 14    |

Cumulative: 89 findings raised, all resolved. Plan ready for implementation.

Total review effort: 3 rounds × 3 experts + 1 Opus security escalation = 10 expert passes.
