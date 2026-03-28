# Plan Review: unified-access-dashboard
Date: 2026-03-28
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

| # | Severity | Status | Summary |
|---|----------|--------|---------|
| F1 | Major | Resolved | audit-logs response missing actorType/serviceAccountId fields → Step 7 expanded |
| F2 | Major | Resolved | api-path.ts missing MCP/AccessRequest constants → Step 1 expanded |
| F3 | Major | Resolved | Access Requests API lacks pagination → noted as full-fetch with future cursor |
| F4 | Major | Resolved | Approve 409 SA_TOKEN_LIMIT_EXCEEDED UI handling → added to Step 4 |
| F5 | Minor | Resolved | Tab icons unspecified → Bot + Activity icons chosen |
| F6 | Minor | Resolved | allowedScopes CSV→array conversion → noted in Step 3 |

## Security Findings

| # | Severity | Status | Summary |
|---|----------|--------|---------|
| S1 | Major | Resolved | actorType query param needs allowlist → Step 7 specifies allowlist |
| S2 | Major | Resolved | MCP Client routes use withBypassRls → Step 7 adds migration to withTenantRls |
| S3 | Minor | Resolved | JIT approve fetch cache: no-store → added to Security section |
| S4 | Minor | Resolved | redirectUris scheme restriction → RFC 8252 https/localhost only |

## Testing Findings

| # | Severity | Status | Summary |
|---|----------|--------|---------|
| T-C1 | Critical | Resolved | Plaintext clear tests in Manual only → moved to automated unit tests |
| T-C2 | Critical | Resolved | Permission role coverage unclear → 4 states (loading/MEMBER/ADMIN/OWNER) specified |
| T-M1 | Major | Resolved | Approve 409 error test missing → added to Testing Strategy |
| T-M2 | Major | Resolved | redirectUri boundary tests → added to Testing Strategy |
| T-M3 | Major | Resolved | Pagination boundary tests → deferred (API is full-fetch, not cursor) |
| T-M4 | Major | Resolved | actorType filter route test → added to Testing Strategy |
| T-m1 | Minor | Resolved | Test naming convention → "follow tenant-webhook-card.test.tsx" noted |
| T-m2 | Minor | Resolved | Tab count change impact → Step 6 updated with impact check note |

## Adjacent Findings
None

## Resolution
All 18 findings addressed in plan update. Proceeding to Round 2 verification.
