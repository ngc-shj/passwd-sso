# Code Review: expand-security-policies
Date: 2026-04-10
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-01 [Major] invalidateLockoutThresholdCache not called — RESOLVED
Action: Added import + call after invalidateTenantPolicyCache in tenant policy PATCH

### F-02 [Major] PASSKEY_ENFORCEMENT_BLOCKED audit not emitted — DEFERRED (TODO-01)
Reason: Edge Runtime limitation; needs fire-and-forget fetch pattern

### F-03 [Major] Cross-field validation bypass with null DB values — RESOLVED
Action: Use schema default fallbacks, remove null guards, always enforce monotonicity

### F-04 [Major] Policy expiry not applied to team scope — DEFERRED (TODO-04)
Reason: Requires team-to-tenant policy resolution in watchtower context

### F-05 [Major] checkPasswordReuse/withTeamIpRestriction defined but not called — DEFERRED (TODO-02, TODO-03)
Reason: Functions are ready; wiring to route handlers/forms is follow-up work

### F-07 [Major] Multi-tenant retention enforcement gap — DEFERRED (TODO-06)
Reason: Design decision needed (per-tenant vs strictest-wins)

### Unlisted: Tenant password policy not enforced in personal form — DEFERRED (TODO-05)
Reason: vault/status exposes data; consuming hook is follow-up work

## Security Findings

### S-01 [Major] Non-timing-safe password comparison — RESOLVED
Action: Replaced === with TextEncoder + XOR constant-time loop

### S-02 [Major] TOCTOU partial-update bypass on lockout validation — RESOLVED
Action: Merged with F-03 fix (schema defaults)

### S-03 [Major] Missing userId in ACCESS_DENIED audit log — RESOLVED
Action: Added optional userId parameter, threaded from callers

### S-04 [Minor] Passkey exempt-path completeness — Noted (sign-out flow unaffected)
### S-05 [Minor] Plaintext tokens in heap — Pre-existing accepted trade-off
### S-06 [Minor] Retention bypass via operatorId — DEFERRED (TODO-06)

## Testing Findings

### C-01 [Critical] No session duration enforcement test — RESOLVED
Action: Added 3 tests to auth-adapter.test.ts

### C-02 [Critical] No password-policy-validation tests — RESOLVED
Action: Created password-policy-validation.test.ts (13 tests)

### C-03 [Critical] No purge-audit-logs tests — DEFERRED
Reason: Route is admin-only with bearer token; follow-up PR

### C-04 [Critical] No passkey-status tests — DEFERRED
Reason: Route is simple session-based GET; follow-up PR

### M-01 [Major] Inconsistent vault/status mock shapes — RESOLVED
### M-03 [Major] Watchtower policy expiry not exercised — RESOLVED (3 tests added)
### M-04 [Major] team-login-form mock missing fields — RESOLVED
### M-05 [Major] No getStrictestSessionDuration tests — RESOLVED (4 tests added)

## Resolution Status

| Finding | Severity | Status |
|---------|----------|--------|
| F-01 | Major | Resolved |
| F-02 | Major | Deferred → TODO-01 |
| F-03/S-02 | Major | Resolved |
| F-04 | Major | Deferred → TODO-04 |
| F-05 | Major | Deferred → TODO-02, TODO-03 |
| F-07 | Major | Deferred → TODO-06 |
| S-01 | Major | Resolved |
| S-03 | Major | Resolved |
| C-01 | Critical | Resolved |
| C-02 | Critical | Resolved |
| C-03 | Critical | Deferred |
| C-04 | Critical | Deferred |
| M-01,M-03,M-04,M-05 | Major | Resolved |
