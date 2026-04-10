# Code Review: expand-security-policies
Date: 2026-04-10
Review rounds: 2

## Round 1 Findings (resolved)

| ID | Severity | Problem | Resolution |
|----|----------|---------|-----------|
| F-01 | Major | invalidateLockoutThresholdCache not called | Added call after policy update |
| F-03/S-02 | Major | Cross-field validation bypass with null | Schema defaults as fallback |
| S-01 | Major | Non-timing-safe password comparison | timingSafeEqual with XOR loop |
| S-03 | Major | Missing userId in ACCESS_DENIED audit | Optional userId parameter added |
| C-01 | Critical | No session duration test | 3 tests added |
| C-02 | Critical | No password-policy-validation test | 13 tests added |
| M-01,M-03,M-04,M-05 | Major | Mock shape issues | All fixed |

## Round 2 Findings (resolved)

| ID | Severity | Problem | Resolution |
|----|----------|---------|-----------|
| BUG-01 | Critical | teamId not passed to useTeamLoginFormState | Added teamId prop + test fixes |
| BUG-02 | Critical | null writes to non-nullable schema fields | Skip null for non-nullable, validate accordingly |
| F3 | Major | /api/internal/audit-emit no rate limit | Added 20 req/min per user |
| ISSUE-01 | Major | null IP + inheritTenantCidrs=true blocks all | Delegate to checkTeamAccessRestriction for tenant CIDR resolution |

## Remaining Items (Low severity, documented)

| ID | Severity | Problem | Status |
|----|----------|---------|--------|
| F1/Sec | Low | timingSafeEqual early return on length mismatch | Client-side only; documented |
| F2/Sec | Low | GET /api/tenant/policy no rate limit | Admin-only endpoint |
| F7/Sec | Low | Passkey exempt list — future-proofing | Comment added |
| F8/Sec | Low | HISTORY_PURGE action reused for audit log purge | Metadata distinguishes; documented |
| ISSUE-02 | Low | Policy check on generator settings not password value | Consistent with team form behavior |
| Missing tests | Medium | passkey-status, audit-emit route tests | Deferred — simple routes |
