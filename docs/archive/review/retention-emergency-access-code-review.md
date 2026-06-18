# Code Review: retention-emergency-access (SC6b)
Date: 2026-06-18
Review rounds: plan (1) + code (1), converged.

## Plan review — PLAN OK
The review thoroughly verified the security-critical death model against the emergency-access lifecycle + state MATRIX:
- Post-accept liveness gates on status/wait_expires_at, NEVER token_expires_at — so an ACCEPTED/IDLE/ACTIVATED grant is live past the invite window.
- The guard (`status IN (REVOKED,REJECTED) OR (status=PENDING AND token_expires_at<now())`) deletes only dead grants. STALE is recoverable (STALE→IDLE transition exists) — correctly EXCLUDED; IDLE recoverable — EXCLUDED. Expired-PENDING is non-revivable (accept route rejects expired invites) — correctly included.
- Recommended hardening: RT7 should assert the cascade child's fate (added).

## Code review — SC6b OK (no findings)
Security-critical review verified clean:
- Guard SQL correct: deletes only REVOKED/REJECTED/expired-PENDING; KEEPS live (ACCEPTED/ACTIVATED/REQUESTED) and recoverable (STALE/IDLE) even past token_expires_at.
- RT7 critical test non-vacuous: inserts created_at=now() so cutoffColumn is always-true; without the guard ALL grants delete → the ACCEPTED/ACTIVATED-kept assertions go red. Proven.
- S1: guard fragment is compile-time-literal status strings in GUARD_SQL; parent=entry.table assertIdentifier-validated; only batchSize bound. Same posture as MCP_TOKEN_FAMILY_DEAD.
- guard applied to SELECT only; DELETE targets captured id list → SELECT/DELETE consistent; unguarded path (SC4/SC6 entries) byte-identical (dedicated unit test).
- Provenance: 8 real @map columns incl. status (enum) — DMMF registry test covers enum columns (the SC6 builder fix).
- R6 cascade: dead grant → emergency_access_key_pairs cascade (integration test proves it under the worker role); no child grant needed.
- R14: SELECT+DELETE on emergency_access_grants only; no over-grant; worker still cannot delete audit_logs.
- enum cast (status IN ('REVOKED',...)): Postgres implicit cast, proven by real-DB integration tests.

One cosmetic nit fixed: registry.test count-title 10→11.

## Verification
- Unit: 10 sweep-sql tests (incl. guard-appended both-OR-branches + unguarded-unchanged); registry DMMF (count 11).
- Integration (real DB, 7 tests): REVOKED/REJECTED deleted; expired-PENDING deleted; live-PENDING kept; **CRITICAL: ACCEPTED/ACTIVATED past-window KEPT**; STALE/IDLE kept; cascade child removed; worker-role least-privilege.
- Full worker suite + audit coverage pass; lint clean; pre-pr.sh 36/36; migration applied to dev DB, grant verified.

## Verdict
Converged. The deferred-from-SC6 table is now GC'd safely with a status-aware guard reusing the SC5 GUARD_SQL mechanism on the provenance path — no live emergency-access grant can be deleted. This completes retention GC for ALL expiry/security tables.

Remaining follow-up: policy API/UI for the per-tenant retention fields (SC2/SC3/SC7) — the worker + columns exist, UI wiring only.
