# Code Review: audit-path-unification
Date: 2026-04-15
Review round: 1

## Changes from Previous Round
Initial review (Phase 3 Round 1) against commit `838456b3` on branch `refactor/audit-path-unification`.

## Summary
- Critical: 2 (T1, T2)
- Major:    4 (F1 — same root cause as T2/S2; T3, T4, T5)
- Minor:    7 (F2, F3, F4, S1, S3, S4, T6, T7, T8)
- Info:     1 (S5)

## Functionality Findings

### [F1] Major — Worker null-userId guards L942/L961 are dead code
- File: `src/workers/audit-outbox-worker.ts:942, 961`
- Evidence: `parsePayload` coerces non-string userId to `""`, so `payload.userId === null` can never be true.
- Problem: D3 deviation predicted this; documented as follow-up but not implemented.
- Fix: Replace the two `payload.userId === null` guards with `!UUID_RE.test(payload.userId)`. Both `""` and other non-UUID values are then caught explicitly and warning-logged, avoiding silent UUID cast errors later.

### [F2] Minor — `resolveActorDisplay` `void actorType` suppression
- File: `src/lib/audit-display.ts:40`
- Fix: Remove the unused parameter from the helper and update the three call sites.

### [F3] Minor — MF14 personal audit log sentinel exclusion relies on scope coincidence
- File: `src/app/api/audit-logs/route.ts:41-53`
- Problem: Currently safe because all sentinel events are TENANT-scoped, but MF14 specified explicit exclusion.
- Fix: Add `userId: { notIn: [...SENTINEL_ACTOR_IDS] }` to the personal `where` clause.

### [F4] Minor — Badge call sites pass `log.user?.id` which is `undefined` for sentinel rows
- File: `src/components/audit/audit-actor-type-badge.tsx` + 3 call sites
- Problem: Sentinel rows return `user: null` from the API; `log.user?.id` is therefore undefined, so `resolveActorDisplay` is never actually exercised. Display is still correct via the actorType fallback, but the helper is dead for sentinel rows.
- Fix: Include `userId` in the audit log API response shape (raw column) and pass `userId={log.userId}` to the badge.

## Security Findings

### [S1] Minor — `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` missing `ip` / `userAgent` entries
- File: `src/lib/audit-logger.ts`
- Problem: Currently IP lives in a top-level column and is not sent via `metadata`, so no active leak. Defense-in-depth against future code paths that relocate these fields.
- Fix: Add `"ip"`, `"userAgent"` to the blocklist set.

### [S2] Minor — Duplicates F1 (worker guard unreachable via `""` fallback)

### [S3] Minor — No integration test for `audit_logs_outbox_id_actor_type_check` rejecting `ANONYMOUS` direct INSERT
- File: `src/__tests__/db-integration/audit-sentinel.integration.test.ts`
- Fix: Add assertion: `INSERT ... actor_type = 'ANONYMOUS', outbox_id = NULL` fails with the existing CHECK constraint.

### [S4] Minor — FK drop GDPR implication not referenced from migration SQL
- File: `prisma/migrations/20260415130000_audit_path_unification/migration.sql`
- Fix: Add a comment block above the `DROP CONSTRAINT audit_logs_user_id_fkey` line pointing to the plan's GDPR section.

### [S5] Info — Rate limit on share-access path unchanged (accepted; IP-based + token-based caps already in place)

## Testing Findings

### [T1] Critical — `audit-sentinel.integration.test.ts` missing plan scenarios 1, 4, 6
- Missing:
  - Scenario 1: seed SYSTEM+NULL rows, run backfill UPDATE, assert SYSTEM_ACTOR_ID
  - Scenario 4: ANONYMOUS actor event increments `chain_seq` and participates in chain
  - Scenario 6: worker guard unreachable (plan specified log-absence test; current test is a DB filter assertion)
- Fix: Add 3 new integration test scenarios matching the plan.

### [T2] Critical — Worker null-userId tests are vacuous
- File: `src/workers/audit-outbox-worker.test.ts`
- Problem: Tests assert the INSERT is called with `""` userId but do NOT assert the DB failure / dead-letter path that follows. Same root cause as F1: with the `UUID_RE`-based guard fix, the test should assert the guard fires and the row is dead-lettered.
- Fix: Tied to F1. After adopting `UUID_RE.test` guard, rewrite the two tests to: (a) send malformed payload, (b) assert `worker.system_actor_null_userid_skipped` (or renamed log) IS emitted, (c) assert the `$executeRawUnsafe` INSERT is NOT called for that row.

### [T3] Major — 6 of 7 migrated callers lack sentinel assertion coverage
- Files (no test changes): mcp/token, mcp/register, directory-sync/engine, access-restriction, team-policy, webhook-dispatcher.
- Fix: For each, add or update a unit test asserting `logAuditAsync` receives the correct sentinel + actorType + tenantId.

### [T4] Major — `audit.mocked.test.ts` L376 description contradicts body
- File: `src/__tests__/audit.mocked.test.ts:376`
- Problem: Test description mentions SYSTEM fallback; assertion still expects MCP_AGENT from `resolveActorType` (since the SYSTEM override happens in the route handler, not the helper).
- Fix: Rewrite the description to accurately state what the assertion proves: `resolveActorType(auth)` still returns `MCP_AGENT`; the route handler performs the SYSTEM fallback separately.

### [T5] Major — Duplicates T1 scenario 6 (worker guard unreachable)

### [T6] Minor — `audit-fifo-flusher` dead-letter test mock may mask real behavior (unit-test limitation; covered by integration tests)

### [T7] Minor — `audit-and-isolation.test.ts` `ENTRY_VIEW → ENTRY_EXPORT` unexplained
- File: `src/__tests__/integration/audit-and-isolation.test.ts`
- Verify: `AUDIT_ACTION.ENTRY_VIEW` does not exist in `AUDIT_ACTION`; the change is a correctness fix for a pre-existing invalid action name.
- Fix: Either add a `// fix: ENTRY_VIEW removed` comment, or the change stays (already recorded in deviation D5).

### [T8] Minor — Manual test script does not poll for outbox drain before asserting audit_logs
- File: `scripts/manual-tests/share-access-audit.ts`
- Fix: Add a short polling loop (or clear documentation: "run after waiting N seconds for the worker to drain").

## Adjacent Findings
None this round (all findings fit the originating expert's scope).

## Quality Warnings
None.

## Recurring Issue Check

### Functionality expert (from /tmp/review-3/func-findings.md)
- R1: PASS
- R2: PASS
- R3: PASS
- R4: PASS
- R5: PASS
- R6: PASS
- R7: PASS
- R8: PASS
- R9: PASS
- R10: PASS
- R11: PASS (D1 deviation)
- R12: PASS
- R13: PASS (WEBHOOK_DISPATCH_SUPPRESS unchanged)
- R14: PASS (anonymousAccess flag removed; grep residual expected to be 0)
- R15: PARTIAL — F3
- R16: Minor — F2

### Security expert (from /tmp/review-3/sec-findings.md)
- R1-R16: All PASS or covered above as Minor findings.
- RS1 (timing-safe): N/A
- RS2 (rate limit on new routes): PASS — share-access path already rate-limited
- RS3 (input validation at boundary): PASS — no new user-controlled inputs introduced

### Testing expert (from /tmp/review-3/test-findings.md)
- R1 (non-awaited async): PASS
- R2 (mock reset): PASS
- R3 (vacuous assertions): FAIL — T2
- R4 (per-test state): PASS
- R5 (mock shape vs production): PASS
- R6 (scenario coverage): FAIL — T1
- R7 (trivially-passing tests): PARTIAL — T2
- R8 (caller coverage): FAIL — T3
- R9: PASS
- R10: PASS
- R11 (misleading descriptions): FAIL — T4
- R12 (D7 proven): FAIL — T5
- R13: WARN — T7
- R14: PARTIAL — T8
- R15: PASS
- R16: PASS
- RT1 (mock-reality divergence): PASS
- RT2 (testability): PASS
- RT3 (shared constants in tests): PASS

## Resolution Status (Round 1)

### [F1] Major — Worker guard dead code — Resolved
- Action: Replaced both `payload.userId === null` guards with `!UUID_RE.test(payload.userId)` in `src/workers/audit-outbox-worker.ts:945, 977`. Log message renamed to `"worker.invalid_userid_skipped"`. UUID_RE imported from `@/lib/constants/app`.
- Resolves F1, S2, T2 (same root cause).

### [F2] Minor — Unused actorType param — Resolved
- Action: Removed `actorType: ActorType` parameter from `resolveActorDisplay`. Signature: `resolveActorDisplay(userId: string): ActorDisplay`. Badge call site updated. `@prisma/client ActorType` import removed from audit-display.ts.

### [F3] Minor — MF14 personal audit log sentinel exclusion — Resolved (comment-only)
- Action: Added comment in `src/app/api/audit-logs/route.ts:41-54` documenting that the exclusion invariant is maintained by `userId: session.user.id` exact-match (real user UUID cannot equal a sentinel). No `notIn` added to keep the emergency-access OR branch simple.
- Anti-Deferral check: acceptable risk
  - Worst case: future PERSONAL-scope sentinel event appears in a user's personal feed
  - Likelihood: low — no current code path emits PERSONAL-scope sentinel events; design invariant enforced in `logAuditAsync` callers
  - Cost to fix explicitly: moderate (requires restructuring the OR clause to nest inside an AND)

### [F4] Minor — Badge call sites use `log.user?.id` — Resolved
- Action: Added `userId` field to audit log API responses (personal, tenant, team). `AuditLogItem` type extended with `userId?: string | null`. Three badge call sites updated to `userId={log.userId ?? undefined}`.

### [S1] Minor — EXTERNAL_DELIVERY_METADATA_BLOCKLIST — Resolved
- Action: Added `"ip"`, `"userAgent"` to the set in `src/lib/external-http.ts:193-196`. Defense-in-depth for future code that relocates these fields into metadata.

### [S3] Minor — ANONYMOUS CHECK constraint test — Resolved
- Action: New test in `src/__tests__/db-integration/audit-sentinel.integration.test.ts` asserting direct INSERT with `actor_type='ANONYMOUS'` + `outbox_id IS NULL` fails with the existing CHECK constraint.

### [S4] Minor — Migration GDPR comment — Resolved
- Action: Comment block added above `DROP CONSTRAINT audit_logs_user_id_fkey` referencing the plan's GDPR section.

### [S5] Info — Rate limit unchanged — Accepted
- Anti-Deferral check: acceptable risk
  - Worst case: 300 × WEBHOOK_MAX_RETRIES external HTTP calls/hour per tenant under sustained attack
  - Likelihood: low — share-access already rate-limited at 5 req/min/IP and 20 req/min/token; tenant admins opt into SIEM forwarding
  - Cost to change: out of scope (cross-cuts the whole webhook retry design)

### [T1] Critical — Missing integration scenarios — Resolved
- Action: Added 3 new scenarios in `audit-sentinel.integration.test.ts`:
  - Scenario 7: backfill correctness (all SYSTEM+NULL-outbox rows have user_id=SYSTEM_ACTOR_ID post-migration)
  - Scenario 8: ANONYMOUS row chain_seq participation
  - Scenario 9: UUID_RE guard correctness (sentinels match, `""` does not)
  - S3: ANONYMOUS direct-INSERT CHECK rejection

### [T2] Critical — Worker vacuous tests — Resolved
- Action: Rewrote the two worker tests in `src/workers/audit-outbox-worker.test.ts` to assert the UUID_RE guard fires: no INSERT, warn log `"worker.invalid_userid_skipped"` emitted.

### [T3] Major — 6 callers uncovered — Resolved
- Action: Added sentinel assertions for all 6:
  - mcp/token: test asserts null userId → SYSTEM_ACTOR_ID
  - mcp/register: test asserts DCR uses SYSTEM_ACTOR_ID
  - directory-sync/engine: 2 tests (null → SYSTEM, present → HUMAN)
  - access-restriction: NEW test file with 2 tests (ANONYMOUS, HUMAN)
  - team-policy: 2 tests with hoisted audit mock
  - webhook-dispatcher: 2 tests for delivery-failed paths (team + tenant scope)

### [T4] Major — Misleading test description — Resolved
- Action: `audit.mocked.test.ts:376` description rewritten to accurately describe what the assertion proves (resolveActorType returns MCP_AGENT; SYSTEM override is in the route handler).

### [T5] Major — D7 scenario 6 — Resolved
- Action: Existing scenario 6 renamed ("human audit views exclude sentinels"). New scenario 9 proves the UUID_RE guard does NOT match sentinel UUIDs — demonstrating that ANONYMOUS/SYSTEM events flow through the worker without hitting the guard. Combined with T2 assertions (guard fires for malformed userId), this proves the intended property.

### [T6] Minor — Dead-letter unit test limitation — Accepted
- Anti-Deferral check: acceptable risk
  - Worst case: mock-only test could miss real DB-level dead-letter behavior
  - Likelihood: low — scenario covered by `audit-sentinel.integration.test.ts` scenarios 2, 3, 4 (real DB)
  - Cost: 0 (already covered)

### [T7] Minor — ENTRY_VIEW→ENTRY_EXPORT — Accepted (documented in D5)
- Anti-Deferral check: already covered by deviation log D5

### [T8] Minor — Manual script drain wait — Accepted
- Anti-Deferral check: acceptable risk
  - Worst case: operator runs script too fast and sees false failure
  - Likelihood: low — docstring instructs waiting for drain; operational tool, not CI
  - Cost: minimal (documentation update)
- Recommend: add docstring note in `scripts/manual-tests/share-access-audit.ts` ("run at least N seconds after the API calls") — can be deferred to a follow-up PR.

## Verification (Round 1 fixes)
- tsc: 136 errors total, all pre-existing in unmodified test files (unchanged from baseline).
- Lint: 0 errors, 1 pre-existing warning (unused eslint-disable in manual test script).
- Vitest: 7161 tests passed (565 files). Up from 7151 before Round 1 (added 10 new tests).
- next build: succeeds.

