# Plan Review: retention-gc-worker

Date: 2026-06-17
Review rounds: 3 (converged — all experts READY TO LOCK)

## Changes from Previous Round

- **Round 1 → 2**: re-scoped the EXPIRY registry from 13 tables to 6 after experts proved (against the schema) that several tables are NOT "the same essential operation": `verification_tokens` (no `id`, composite PK), `mcp_access_tokens` (`ON DELETE CASCADE` to live 7-day refresh tokens), and the forensic-provenance credential tables. Replaced free-form SQL `predicate` with a structured `PredicateClause[]`; added `keyColumns` engine support; corrected the audit-action consumer list; dropped the over-privileged `audit_logs` grant; enumerated the full DCR-absorption surface (initdb/k8s/CI/env-docs/allowlist) and test-harness/CI role plumbing.
- **Round 2 → 3**: corrected the **inverted** `bypass_rls` rule (INV-C2b) — bypass_rls is required for EVERY RLS-enabled table, not only `tenant_id IS NULL` targets (a NOBYPASSRLS worker without it hits the `''::uuid` cast error); added `globalDelete: true` to the 5 RLS-enabled entries; corrected the "no forensic provenance" criterion to "provenance-free OR duplicated in audit_logs"; named the `_emitFn` deterministic failure-injection for the idempotency test; tightened the composite-key matrix, the DMMF positive-mapping assertion, and the role positive+negative-on-one-client requirement.

## Functionality Findings

**Round 1 (all RESOLVED):**
- F1 Critical: `verification_tokens` has no `id` column (composite PK `@@unique([identifier, token])`) — the generic `USING(SELECT id ...)` pattern throws. → Engine reworked to `keyColumns` + `(keys) IN (SELECT keys ... LIMIT $1)`; INV-C1b boot-check.
- F2 Critical: `mcp_access_tokens` `ON DELETE CASCADE` (schema:1968/1991) destroys live 7-day `mcp_refresh_tokens` + `delegation_sessions` when its 1-hour-expired row is deleted, breaking OAuth refresh. → Moved to SC5 (deferred, family-aware design).
- F3 Major: DCR absorption surface larger than enumerated. → C9 enumerates env-descriptions, env-allowlist, docker-compose db var, initdb 03/04, k8s, ci-integration, password-setter script+test.
- F4 Major: audit-action consumer list inaccurate. → C6 corrected to exact sites (AUDIT_ACTION:18, AUDIT_ACTION_VALUES:219, AUDIT_ACTION_GROUP.MAINTENANCE:~715) + the two coverage tests as binding consumers.
- F5 Minor: over-grant SELECT/INSERT on audit_logs. → Dropped; emit to audit_outbox only; REFERENCES revoke added.
- F6 Minor: api_keys/operator/SA tokens carry forensic provenance. → Moved to SC4.
- F7 Adjacent: per-entry-tx heartbeat-loss residual. → Per-entry `{table, code}` log made authoritative error record.

**Round 2 (all RESOLVED):**
- F8 Minor: globalDelete flag missing for tenant-scoped tables. → Added to type + 5 registry rows + INV-C2b.
- F9 Minor: "no forensic provenance" criterion false. → Reworded; provenance duplicated in audit_logs.
- F10 Minor: used-but-unexpired single-use codes retained. → Noted explicitly (single-use rejection at consume time).
- F11 Minor: mcp_refresh_tokens unnamed in SC5. → Added to SC5 parenthetical.
- F12 Trivial: stale "no forensic provenance" in Scope abstract. → Reworded line 18.

## Security Findings

**Round 1 (all RESOLVED):** S1 (free-form predicate → structured AST), S2 (bypass_rls blast radius → globalDelete ack), S3 (ephemeral vs forensic split → SC4), S4 (audit purge ≥30 floor + SYSTEM anchor), S5 (drop audit_logs grant + REFERENCES revoke), S6 (no SQL/predicate in logs), S7 (credential parity), S8 (verification_tokens keyless → keyColumns).

**Round 2:**
- S10 Critical (escalate, RESOLVED round 3): the round-1 S2 fix was inverted. RLS policy `USING (... bypass_rls='on' OR tenant_id = current_setting('app.tenant_id')::uuid)` (migration 20260227043000:380 / 20260321110000:404) makes a NOBYPASSRLS worker without `app.tenant_id` hit `''::uuid` cast error → 0-row silent failure on 4 of 6 tables. → INV-C2b corrected: bypass_rls for EVERY RLS-enabled table; engine REQUIRES globalDelete:true (boot-throw if missing); verification_tokens (no RLS) is the sole exception. Verified against the dcr precedent (always sets bypass_rls, dcr-cleanup-worker.ts:95).
- S11 Major (RESOLVED round 3): "no forensic provenance" false for sessions/bridge codes (carry ip/userAgent). → Criterion reworded; round-3 empirically confirmed bridge-code exchange emits audit events with IP/UA (extension/token/exchange/route.ts:246, mobile/token/route.ts:258), so tables stay in EXPIRY.
- S12/S13 Minor: DCR cascade double-path (safe, test note) / mcp_authorization_codes ephemerality confirmed.

**Round 3:**
- S14 Low (non-blocking, tracked): globalDelete requirement is author-declared, not derived from pg_policies. Follow-up TODO recorded in plan with Anti-Deferral cost-justification (worst case = future silent GC gap, not security bypass; cost ~30min; deferred to avoid adding DB dependency to a pure-DMMF unit test).

## Testing Findings

**Round 1 (all RESOLVED):** T1 (helpers.ts TestRole role), T2 (ci-integration role password), T3 (DMMF dbName??name), T4 (single-flight documented-untested), T5 (RT7 positive control), T6 (NULL-skip mechanism), T7 (no snapshot), T8 (port 9-row matrix), T9 (env-contract test), T10 (3 dcr test disposition), Adjacent (tx-rollback → idempotency test).

**Round 2 (all RESOLVED):**
- T11 Minor: role positive+negative must run on same client. → C10 acceptance states it.
- T12 Minor: composite-key verification_tokens needs concrete matrix. → C2 acceptance: 3-row shared-identifier mixed-expiry matrix.
- T13 Major: idempotency test failure-injection unnamed. → C4 names `_emitFn` into the final heartbeat tx (deterministic; hook confirmed in sweepOnce signature).
- T14 Minor: DMMF regression must assert positive mapping. → INV-C1a: positively maps sessions.expires → present-in-resolved-columns.

## Adjacent Findings

- F7 (per-entry-tx heartbeat atomicity) → routed to functionality + testing; resolved (authoritative per-entry log + idempotency test replacing the now-false atomicity test).
- S8 / F1 (verification_tokens keyless) → dual-classified (functionality SQL shape + security silent non-deletion of auth tokens); resolved by keyColumns engine.

## Quality Warnings

None — Ollama merge unavailable in this session; deduplication performed manually by the orchestrator. All findings carried Evidence (file:line) and concrete Fixes; no VAGUE/NO-EVIDENCE/UNTESTED-CLAIM findings were emitted.

## Recurring Issue Check

### Functionality expert
- R5 (TOCTOU): N/A — DELETE-by-cutoff idempotent.
- R6 (cascade orphans): Finding F2 (mcp_access_tokens) → deferred SC5; vault-trash/Attachment → SC2; 6 included tables verified zero inbound FK refs.
- R9 (fire-and-forget in tx): conscious documented deviation (C4 per-entry tx + non-atomic heartbeat, justified by idempotency).
- R12 (audit action coverage): Finding F4 → resolved.
- R14 (grant completeness): Finding F5 → resolved (no audit_logs grant).
- R15 (dynamic DB name): Checked — `current_database()`.
- R32 (boot ready signal): Checked — C8 `retention-gc.loop_start`.
- R35 (manual test): Checked — C11 two-filter.
- Others R1-R4, R7-R8, R10-R11, R13, R16-R31, R33-R34, R36-R41: N/A or Checked-no-issue.

### Security expert
- R6: deferred correctly (SC2/SC5).
- R9: documented deviation.
- R14/R15/R16: C7 mirrors dcr/outbox grant migrations; positive+negative role controls in C10.
- R31: DCR role kept-but-unused, no DROP ROLE.
- RS1 (timing-safe): N/A. RS2 (rate limit): N/A (worker, no route). RS3 (input validation): Finding S1 → structured predicate. RS4 (PII in artifacts): Checked — no PII. RS5 (untrusted security param): N/A.
- Others: N/A or Checked.

### Testing expert
- R16 (dev/CI parity): Findings T1/T2 → resolved (harness + CI role plumbing).
- R32/R35: Checked — C8/C11.
- RT1 (mock-reality): Checked — correctness claims in real-DB integration, not mocked.
- RT2 (testability): Checked — all hooks exist (_emitFn, --validate-env-only, getConnectionString role case, Prisma.dmmf).
- RT4 (race vacuous): single-flight documented-untested, no vacuous test present.
- RT5 (test connects AS role): Findings T1/T5/T11 → resolved (positive+negative on one client).
- RT7 (prove-it-can-fail): Finding T5 → positive control + both-branch allowlist.
- RT3/RT6: N/A. Others: N/A or Checked.

## Verdict

All three experts: **READY TO LOCK**. Two Critical (F1, F2), eight Major, plus Minors across rounds 1-2 — all resolved; round-3 verified resolutions against the codebase and empirically closed the one open verification (S11 bridge-code audit emit). One Low follow-up (S14) tracked with Anti-Deferral justification. Go/No-Go Gate: C1-C11 all locked.
