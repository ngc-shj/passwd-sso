# Plan Review: owasp-rereview-stepup-and-failclosed
Date: 2026-06-27
Review round: 1 (initial)

## Changes from Previous Round
Initial review. Three expert sub-agents (functionality / security / testing) reviewed the plan against the codebase.

## Functionality Findings
- **F2 (Major) — FIXED**: team `[id]` DELETE computes `permanent` AFTER the existence check; "inside if(permanent) after permission" was unsatisfiable. Plan now hoists `permanent` above the existence lookup and gates step-up right after `requireTeamPermission` (mirrors reference, avoids existence-oracle-before-step-up).
- **F7 (Major) — FIXED**: C2's `checkScimRateLimit` boolean→`RateLimitResult` is a breaking signature change; plan now enumerates the single caller (`authorizeScim`) + the test file that must change.
- **F9 (Major) — FIXED**: `rateLimited` import handling is per-file: remove from scim-tokens/service-accounts, KEEP in operator-tokens (list path still uses it).
- **F5/F6 (Info/Low) — FIXED**: C2's manual `scimError` branch is cleaner than forcing `checkRateLimitOrFail`'s envelope form; confirmed `req`/`tenantId` in scope.
- Verified clean: all 6 endpoints truly permanent-delete; `req` in scope everywhere; no token path on the session-only purge endpoints (no token-guard needed).

## Security Findings
- **S1 (High, escalate) — FIXED (scope extended)**: `/api/vault/reset` wholesale-deletes ALL entries with only session + a fixed public confirmation phrase, no step-up — strictly more destructive than the 5 scoped endpoints, contradicting C1's invariant. Added to C1. `/api/vault/admin-reset` deliberately excluded (token-gated, admin-initiated) and documented in SC4. (User approved extending M1 to vault/reset.)
- **S6 (Info, analysis) — FIXED (documented)**: M2 fail-closed also blocks SCIM deactivation during a Redis outage (deprovisioning-latency regression). Net judgment: still correct (in-memory fallback doesn't actually cap; 503 is a retryable SCIM signal). Trade-off + possible follow-up documented.
- **S7 (Low residual) — FIXED (documented SC5)**: SA-create has no step-up (unlike scim/operator-token create); C3 caps mint volume but step-up parity is a future follow-up.
- **S8 (Low) — FIXED**: M2 audit made MANDATORY (`emitRateLimitFailClosed`), not optional — parity with M3; the "heavy deps" concern was unfounded.
- **S3/S4/S5 (Info) — confirmed/documented**: team live-row hard-delete confirmed (gating inside if(permanent) correct); 15min step-up window correct to keep uniform; leaked-cookie-within-15min residual stated plainly.

## Testing Findings
- **T1/T2 (High) — FIXED**: 3 existing M1 test files lack a `requireRecentCurrentAuthMethod` mock → adding step-up breaks their happy-path 200 tests. Mock made MANDATORY; the misleading "returns undefined and behavior is fine" note removed.
- **T3/T9 (High) — FIXED**: every stale/redisErrored test must assert BOTH the status AND that the delete/create did NOT run (vacuous-403/503 guard). Made mandatory in Testing strategy.
- **T4 (Medium) — FIXED**: team empty-trash test hides its deleteMany spy in a closure; plan now requires hoisting it so the negative assertion is observable.
- **T5/T6 (High) — FIXED**: C2 boolean→object breaks `rate-limit.test.ts` (2 assertions) + `with-scim-auth.test.ts` (beforeEach + 429 mock); enumerated. M2 coverage is the sole safety net (SC2).
- **T7/T10 — FIXED**: mint route tests mock the limiter `.check` (not `checkRateLimitOrFail`) so existing 429 tests stay meaningful and the `redisErrored` literal lands in a live mock value.
- **T8 (High) — FIXED**: service-accounts has no 429 test and no `redisErrored` → CI guard would fail on landing C3; plan now requires adding both.
- **T11 (Info) — FIXED**: count math 58→61 confirmed; comment block update required.

## Resolution Status
All High findings (S1, T1/T2, T3/T9, T5/T6, T8) reflected. All Major (F2, F7, F9) reflected. Minor/Info documented. C1 expanded to 6 endpoints. No contract signature/invariant left contradictory. Cleared to Phase 2.

## Phase 3 (code review of implementation)
Three experts reviewed the implemented diff.
- **Functionality: No findings.** Completeness independently re-verified by grep across app/services/vault — all 7 permanent password-delete endpoints enumerated (6 gated + admin-reset intentionally excluded). Placement, imports, ordering correct.
- **Security: No findings.** Step-up unbypassable in all 6 (guard before delete; `permanent` hoisted in team [id]; soft-delete exempt); fail-closed correct in all 5 surfaces; reset-vault `||` covers both limiters before record creation; audit + residual sound. Confirmed all 6 endpoints are session-only (not Bearer-reachable via cors-gate BEARER_RULES).
- **Testing: 1 Low (T1) — FIXED.** E2E `vault-reset.spec.ts` AND `trash.spec.ts` inject a global-setup session and call a now-step-up'd endpoint; if the suite runs >15min after setup, `requireRecentSession` (createdAt ≤15min) 403s them. Added an e2e helper `refreshSessionRecency(sessionToken)` (UPDATE sessions SET created_at = now()) and call it before the step-up'd action in both specs. **Cannot run Playwright locally — needs CI e2e verification.** No other e2e spec hits the step-up'd endpoints (verified by grep).

### Implementation regression caught during Phase 2 (and the lesson)
Adding step-up + the SCIM signature change initially broke **95 tests** because affected test files weren't fully enumerated: (a) 7 SCIM route tests mock `checkScimRateLimit` as a boolean (now returns RateLimitResult), and (b) duplicate purge tests in `src/__tests__/api/` (separate from the `route.test.ts` tree) didn't mock the step-up helper. Both fixed. Root cause = the same incomplete-enumeration failure mode as S1 in Phase 1. Mitigation applied: always grep ALL test files that mock a changed symbol or exercise a changed handler (both test trees + e2e), not just the obvious siblings.

### Production nit caught by Phase 2 subagent — FIXED
`emitRateLimitFailClosed` was called without `void` in both with-scim-auth.ts and reset-vault (floating promise, inconsistent with the canonical `void emit...` pattern). Both fixed.

## Recurring Issue Check (consolidated)
- R1 (reuse): PASS — reuses requireRecentCurrentAuthMethod (C1), checkRateLimitOrFail (C3); C2 deliberately uses a local scimError branch (forcing the helper would be worse).
- R3 (propagation / all-callers): FIXED — checkScimRateLimit caller+test enumerated (F7); per-file rateLimited import (F9); 3 existing M1 test files (T1).
- R17 (helper adoption): PASS — step-up + checkRateLimitOrFail adoption consistent; F2 placement corrected to mirror reference.
- Anti-deferral (feedback_no_skip_existing_code): S1 honored — vault/reset not skipped despite predating the plan.
- Vacuous tests (RT1): T3/T9/T4 made mandatory.
