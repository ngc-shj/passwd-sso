# Plan Review: unified-access
Date: 2026-03-28
Review round: 1

## Changes from Previous Round
Initial review

## Local LLM Pre-screening (9 findings, all addressed before expert review)
1. Token hashing: Clarified SHA-256 is standard for high-entropy bearer tokens
2. MCP isolation: Added rate limiting + request size limit, future process separation noted
3. Key provisioning: Plan explicitly states encrypted-only, decryption client-side
4. Scope backward compat: Added explicit parsing rules
5. Token revocation: Clarified no caching, direct DB lookup
6. serviceAccountId index: Added to AuditLog migration
7. AccessRequest approvedById: Already defined in schema
8. External AI tool tests: Clarified as manual, not CI
9. 365d SA token expiry: Matches existing API key pattern

## Functionality Findings

### [M-1] Major: AuditLog userId NOT NULL conflicts with SERVICE_ACCOUNT actors
- **Problem:** AuditLog.userId is NOT NULL + FK to User. SA actions have no associated user.
- **Impact:** Dummy UUIDs pollute user-scoped queries; making nullable affects 90+ references.
- **Resolution:** userId stores SA's createdById; actorType + serviceAccountId identify actual actor.

### [M-2] Major: proxy.ts Bearer bypass list needs SA token routes
- **Problem:** handleApiAuth does not recognize sa_ tokens for Bearer bypass.
- **Impact:** SA tokens get 401 from middleware before reaching route handlers.
- **Resolution:** Added explicit proxy.ts update step with SA token route registration.

### [M-3] Major: JIT approval race condition
- **Problem:** Non-atomic approve can create multiple tokens from same request.
- **Impact:** Multiple tokens with potentially different TTLs issued for single request.
- **Resolution:** Single transaction + optimistic lock (WHERE status='PENDING').

### [M-4] Major: McpAccessToken userId + serviceAccountId both nullable
- **Problem:** No constraint prevents actor-less tokens.
- **Impact:** Unattributable MCP access, broken audit trail.
- **Resolution:** CHECK constraint at DB level + Zod validation at app level.

### [m-1] Minor: Scope qualifier format vs hasApiKeyScope exact match
- **Resolution:** Clarified scope-parser applies only to SA/MCP tokens. hasApiKeyScope unchanged.

### [m-2] Minor: ServiceAccount isActive=false should invalidate tokens
- **Resolution:** Added isActive check to validateServiceAccountToken().

### [m-3] Minor: Dashboard pagination needs actorType index
- **Resolution:** Added (tenantId, actorType, createdAt DESC) index.

## Security Findings

### [S-1] Critical (escalate: true): Scope CSV injection + authOrToken dispatch
- **Problem:** SA token creation could accept forbidden scopes if using CSV string instead of allowlist. Unknown prefix could fall through to extension token path.
- **Impact:** vault:unlock scope in SA token; chained risk across Phase 1/2/3.
- **Resolution:** Enumerated allowlist (z.enum) for scopes. Prefix table dispatch with explicit null for unknown prefixes.

### [S-2] Major: JIT approval cross-tenant IDOR
- **Problem:** Missing tenantId check allows cross-tenant admin to approve requests.
- **Impact:** Horizontal privilege escalation.
- **Resolution:** Explicit tenantId match check. withBypassRls() prohibited in JIT flow.

### [S-3] Major: McpClient clientSecret bcrypt misuse
- **Problem:** bcrypt for random-generated secrets is algorithm misuse + DoS vector.
- **Impact:** Unnecessary CPU cost; rate limit reached before bcrypt becomes bottleneck.
- **Resolution:** Changed to SHA-256 (hashToken pattern). Rate limit key = client_id.

### [S-4] Major: In-process MCP SSRF risk
- **Problem:** Future MCP tool expansion could access internal network.
- **Impact:** SSRF to DB/Redis/internal APIs.
- **Resolution:** Zod strict input, no URL args in Phase 3. Outbound allowlist for future tools.

### [S-5] Minor: McpAccessToken actor null (merged with Func M-4)

### [S-6] Minor: scope CSV length DB/app mismatch
- **Resolution:** VarChar(1024) + Zod max(1024) aligned. Consider scope count limit.

### [S-7] Minor: AuditLog migration backfill (merged with Test T-5)

## Testing Findings

### [T-1] Critical: No cross-tenant test for validateServiceAccountToken
- **Problem:** Missing "token from different tenant rejected" case.
- **Resolution:** Added to Phase 1 test plan.

### [T-2] Critical: OAuth PKCE failure paths not listed
- **Problem:** Missing verifier missing/invalid/replay test cases.
- **Resolution:** Added explicit PKCE failure test cases to Phase 3.

### [T-3] Major: Scope qualifier backward compat integration test missing
- **Resolution:** Added to Phase 2 testing strategy.

### [T-4] Major: auth-or-token.ts 80% coverage threshold
- **Resolution:** Added explicit coverage maintenance requirement to Phase 1.

### [T-5] Major: AuditLog migration backfill verification
- **Resolution:** Added post-migration assertion script to Phase 4.

### [T-6] Major: MCP stream error handling tests missing
- **Resolution:** Added disconnect/timeout test cases to Phase 3.

### [T-7] Minor: SA test file placement convention
- **Resolution:** Specified route.test.ts convention in Phase 1 testing.

### [T-8] Minor: Phase 3 E2E test layer ambiguity
- **Resolution:** Clarified as Vitest integration test. Manual test for AI tool integration.

## Adjacent Findings
- [Adjacent/Func] Major: bcrypt latency concern for clientSecret → routed to Security, merged with S-3.

## Resolution Status
All 18 unique findings addressed in plan revision (Round 1).
- Critical: 3 (all resolved)
- Major: 8 (all resolved)
- Minor: 7 (all resolved)
