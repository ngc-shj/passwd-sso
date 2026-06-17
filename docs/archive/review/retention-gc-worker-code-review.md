# Code Review: retention-gc-worker
Date: 2026-06-17
Review round: 1 (fixes applied)

## Changes from Previous Round
Initial code review (Phase 3 Round 1), incremental on top of the Phase 2 self-R-check baseline. Three expert sub-agents reviewed the committed diff vs origin/main.

## Functionality Findings
- **F1 [Minor]**: `AUDIT_ACTION.AUDIT_LOG_PURGE` was added to the `MAINTENANCE` audit group alongside `RETENTION_GC_SWEEP`, but it already lived in the `ADMIN` group — an unintended, unrequested duplication that broadened the tenant audit-log "Maintenance" filter. **Fixed**: removed the extra line; `MAINTENANCE` gains only `RETENTION_GC_SWEEP`.
- **F2 [Minor]**: Dead `dcrWorker` test-harness wiring (`TestContext` field, `getConnectionString` case, instantiation, cleanup, return) left behind after the dcr integration tests were ported/deleted — C10 said remove after porting; zero consumers remained (`revoke-public-connect` test uses a catalog query, not the client). **Fixed**: removed all `dcr-cleanup-worker` harness wiring from helpers.ts (the DB role itself stays per C7 kept-but-unused decision).

Focus-area verdicts: sweep.ts `(keys) IN (SELECT ... LIMIT $1)` correct for single+composite keys; `sweepOnce` `-1` sentinel never misinterpreted by consumers; `sweepAuditLogs` floor/cutoff math correct; `validateRegistry` runs before pool open; Implementation Checklist fully satisfied; DCR absorption complete; deviations D1-D6 sound.

## Security Findings
**No findings (Go).** All S1-S14 mitigations confirmed in committed code:
- RS3: every interpolated identifier allowlist-validated (boot + sweep), only `$1`=batchSize bound, predicate renders only `true`/`false` literals.
- S2/S10: bypass_rls all-tenant reach intentional + bounded by cutoff/predicate; RLS-free exception correct (verification_tokens only); S14 residual correctly tracked as non-security follow-up.
- S4: ≥30d floor fail-closed (`Math.max`); deletion only via `audit_log_purge`; SYSTEM heartbeat anchor unreachable by tenant admins + never enumerated.
- R14/D2: grant set re-derived exact; users/teams/service_accounts removal confirmed correct.
- S6/S7: no err.message / SQL / connection-string in any log path.
- DCR retirement: no new attack surface (role kept-but-unused, password required-var removed from compose; definer fn search-path-pinned).

## Testing Findings
- **T-A [Major]**: The locked C2 acceptance — a **unit** test asserting `sweepExpiryEntry`'s generated SQL string + `[batchSize]` param binding — was never implemented; only integration behavior was covered, leaving the param-binding/string-building surface unguarded against silent regression. **Fixed**: added `src/workers/retention-gc-worker/__tests__/sweep-sql.test.ts` (4 tests: single-key SQL shape + `[batchSize]` exact param + no `${`/inlined-batchSize; composite-key `(identifier, token) IN`; structured-predicate concatenation; bypass_rls GUC issued for globalDelete).
- **T-B [Minor]**: The C3 audit-logs mechanism test runs as superuser, so it cannot itself observe the `audit_log_purge` route — INV-C3b is co-guarded by the separate role negative-grant test. **Fixed**: expanded the test header comment to document the two-file co-guard so readers do not over-trust the header claim.
- **T-C [Minor]**: The `sweep-isolation` unit mock did not model `sweepOnce`'s extra heartbeat `$transaction` call (harmless today because the mock ignores the callback, but fragile to a future mock that invokes it). **Fixed**: added an explicit `callIndex >= entryOrder.length` guard returning 0 for the heartbeat call + a comment.
- **T-H [Adjacent/Minor]**: 3 single-use-code tables (extension_bridge_codes, mobile_bridge_codes, mcp_authorization_codes) have only wiring coverage (count≠-1), not dedicated delete-correctness integration tests. **Accepted** (see Resolution Status — Anti-Deferral).
- T-D, T-E, T-F, T-G: verified sound (DMMF cross-check positive-mapping; validateRegistry both-branch; composite-key matrix; dcr-test deletion clean) — no findings.

## Adjacent Findings
- T-H (Testing→Functionality): per-table delete correctness for 3 code tables relies on shared-codepath inference. Accepted with justification.

## Quality Warnings
None — Ollama merge unavailable; deduplicated manually. All findings carried file:line evidence and concrete fixes.

## Recurring Issue Check
### Functionality expert
- R5 N/A (single-statement idempotent delete); R6 verified (no live cascade in scope); R9 documented deviation; R10 clean (inlined enqueue avoids @/lib/prisma cycle); R12 Finding F1 (fixed); R14 verified; R15 current_database(); R16 role test positive+negative; R24 split migration; R25 N/A; R31 role kept; R32 ready signal present. Others N/A.
### Security expert
- RS1 clean (least-privilege exact; SYSTEM tenant unreachable); RS2 clean (no leakage); RS3 clean (allowlist + bound param + literal-only predicate); RS4 N/A; RS5 clean (bypass_rls ack'd, per-tenant purge keyed by tenant.id). R6/R9/R14/R24/R31/R32 as above. Others N/A.
### Testing expert
- RT1 pass (real prisma path; isolation mock shape matches); RT2 confirmed testable; RT3 pass (UUID casts consistent); RT4 documented-untested (dcr parity); RT5 pass (worker client positive+negative on one client); RT6 pass (explicit assertions, valid+invalid, no value echo); RT7 — T-A gap fixed (SQL-shape now red-capable), isolation + validateRegistry both-branch red-capable.

## Environment Verification Report
- **VC1** (concurrent/DELETE-only-expired on live DB): `verified-local` — `npm run test:integration -- src/__tests__/db-integration/retention-gc-worker` (12 tests pass against running Postgres).
- **VC2** (worker container boot in deployment shape, R32): `blocked-deferred` — declared ready signal (`retention-gc.loop_start`/`sweep_done`) documented in C8 + manual-test.md; docker-shape boot is an operator manual-test step (linked: Phase-1 VC2 entry). Not run this round; manual-test.md is the gating artifact.
- **VC3** (least-privilege role grants): `verified-local` — role created on dev DB, grants verified via `information_schema.role_table_grants` (exact set), role connect verified, negative-grant (audit_logs/tenants DELETE → permission denied) verified in role integration test. CI parity: ci-integration.yml ALTERs the role to the matching password.

## Resolution Status
### F1 [Minor] AUDIT_LOG_PURGE duplicate group — Fixed
- Action: removed `AUDIT_ACTION.AUDIT_LOG_PURGE` from the MAINTENANCE group (kept only RETENTION_GC_SWEEP).
- Modified file: src/lib/constants/audit/audit.ts:724

### F2 [Minor] Dead dcrWorker harness wiring — Fixed
- Action: removed the `dcr-cleanup-worker` TestRole case, getConnectionString branch, TestContext field, instantiation, cleanup disconnect, and return reference.
- Modified file: src/__tests__/db-integration/helpers.ts

### T-A [Major] Missing unit SQL-shape assertion for sweepExpiryEntry — Fixed
- Action: added sweep-sql.test.ts with 4 explicit-string assertions (no snapshot).
- Modified file: src/workers/retention-gc-worker/__tests__/sweep-sql.test.ts (new)

### T-B [Minor] Audit-logs mechanism co-guard undocumented — Fixed
- Action: expanded test header comment documenting the two-file mechanism co-guard.
- Modified file: src/__tests__/db-integration/retention-gc-worker-audit-logs.integration.test.ts:8-19

### T-C [Minor] Isolation mock omits heartbeat call — Fixed
- Action: added explicit heartbeat-call guard + comment in the mock.
- Modified file: src/workers/retention-gc-worker/__tests__/sweep-isolation.test.ts:28-49

### T-H [Adjacent/Minor] 3 code tables wiring-only coverage — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a per-table-specific delete bug in extension_bridge_codes / mobile_bridge_codes / mcp_authorization_codes ships untested by a *dedicated* delete-correctness case.
  - Likelihood: low — all three are id-keyed EXPIRY entries running the IDENTICAL `(id) IN (SELECT id ... LIMIT $1)` codepath that IS delete-correctness-tested via sessions and mcp_clients; their cutoffColumn is pinned by the DMMF cross-check (registry.test.ts) and their grant by the role test; the "all entries run, no -1" integration test proves their SQL+grant execute against the real schema.
  - Cost to fix: ~15 min (one parametrized case seeding an expired row per table), but it would be near-duplicate of the proven id-keyed path with no new failure mode reachable.
- **Orchestrator sign-off**: acceptable-risk exception satisfied — identical proven codepath + DMMF/grant/run coverage closes the reachable failure modes; a dedicated delete case adds no new red-capable assertion.
