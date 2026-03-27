# Code Review: unified-access
Date: 2026-03-28T08:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### FUNC-01 [Major] MCP tools do not check scopes
- **File**: `src/lib/mcp/tools.ts`, `src/lib/mcp/server.ts`
- **Problem**: 3 MCP tools ignore `McpTokenData.scopes`. A token with only `credentials:list` can call `get_credential`.
- **Impact**: MCP scope system is entirely non-functional.
- **Recommended action**: Add scope check per tool in `handleToolsCall()` dispatch.

### FUNC-02 [Major] `checkAuth()` SA path passes `serviceAccountId` as `userId` to `enforceAccessRestriction`
- **File**: `src/lib/check-auth.ts` lines 88-95
- **Problem**: SA token path calls `enforceAccessRestriction(req, authResult.serviceAccountId, authResult.tenantId)`. If IP restriction triggers `logAudit({ userId: serviceAccountId })`, the FK to `users.id` fails.
- **Impact**: SA token + IP-restricted tenant → 500 instead of 403.
- **Recommended action**: Use SA's `createdById` or skip `enforceAccessRestriction` for SA tokens, performing only an inline CIDR check.

### FUNC-03 [Major] JIT approval bypasses `MAX_SA_TOKENS_PER_ACCOUNT` limit
- **File**: `src/app/api/tenant/access-requests/[id]/approve/route.ts`
- **Problem**: Token creation via JIT does not check existing active token count.
- **Impact**: Unlimited tokens can be issued per SA via repeated JIT approvals.
- **Recommended action**: Add token count check inside approval transaction.

### FUNC-04 [Minor] Inactive SA can have tokens created via direct endpoint
- **File**: `src/app/api/tenant/service-accounts/[id]/tokens/route.ts`
- **Problem**: `isActive` is fetched but not checked before creating tokens.
- **Recommended action**: Add `!sa.isActive` guard → 409.

## Security Findings

### SEC-01 [Critical] OAuth code exchange TOCTOU — not wrapped in `$transaction`
- **File**: `src/lib/mcp/oauth-server.ts` lines 132-193
- **Problem**: `findUnique` → check `usedAt` → `update` is not atomic. Two concurrent requests can both pass the `usedAt` check and issue two valid access tokens for a single authorization code.
- **Impact**: OAuth 2.1 code replay → duplicate token issuance.
- **Recommended action**: Wrap in `prisma.$transaction()`.
- **escalate**: true
- **escalate_reason**: Multi-step trust boundary (authorize→code→token→tool). Replayed code yields a second token indistinguishable from legitimate.

### SEC-02 [Critical] JIT approval writes unvalidated `requestedScope` as token scope
- **File**: `src/app/api/tenant/access-requests/route.ts`, `src/app/api/tenant/access-requests/[id]/approve/route.ts`
- **Problem**: `requestedScope` is `z.string().min(1).max(2048)` with no SA scope allowlist or forbidden scope check. At approval, it's written directly to `serviceAccountToken.scope`.
- **Impact**: Admin can craft a token with `vault:unlock` — a forbidden scope — via the JIT path.
- **Recommended action**: Validate `requestedScope` at creation with `z.array(z.enum(SA_TOKEN_SCOPES))`. Re-validate at approval.

### SEC-03 [Major] `/api/mcp/token` has no rate limiting
- **File**: `src/app/api/mcp/token/route.ts`
- **Problem**: No rate limiter on token endpoint. Plan required rate limit per `client_id`.
- **Recommended action**: Add `createRateLimiter({ windowMs: 60_000, max: 10 })` keyed on `client_id`.

### SEC-04 [Major] Token exchange lacks explicit tenant guard
- **File**: `src/lib/mcp/oauth-server.ts` lines 143-145
- **Problem**: No check that `authCode.tenantId === authCode.mcpClient.tenantId`. Under `withBypassRls`, a future refactor could allow cross-tenant code exchange.
- **Recommended action**: Add explicit `tenantId` equality check.

### SEC-05 [Major] `status` query parameter cast as `never` without enum validation (= FUNC-05)
- **File**: `src/app/api/tenant/access-requests/route.ts` line 56
- **Problem**: URL query string passed directly to Prisma. Invalid value → 500 with potential stack trace leak.
- **Recommended action**: Validate against `z.enum(["PENDING","APPROVED","DENIED","EXPIRED"])`.

### SEC-06 [Minor] OAuth authorize endpoint has no user consent screen
- **File**: `src/app/api/mcp/authorize/route.ts`
- **Problem**: GET request silently issues authorization code without user interaction. OAuth 2.1 requires explicit consent.
- **Recommended action**: Add minimal consent step (deferred to UI phase, note in code).

## Testing Findings

### TEST-01 [Critical] No route handler tests for any of 14 new API endpoints
- **Files**: All `src/app/api/tenant/service-accounts/`, `access-requests/`, `mcp-clients/`, `mcp/` routes
- **Problem**: Zero companion test files. Plan required SA CRUD + tenant isolation + JIT approve tests.
- **Recommended action**: Create route tests for at minimum: SA CRUD, JIT approve (409 conflict), MCP token endpoint.

### TEST-02 [Major] Modified route handlers have no tests for `service_account` rejection branch
- **Files**: 7 modified route files (`passwords/`, `api-keys/`, `teams/`, `vault/`)
- **Problem**: SA rejection branch added but no tests verify it.
- **Recommended action**: Add one test per modified route: `service_account` type → 401.

### TEST-03 [Major] `resolveActorType()` has no test coverage
- **File**: `src/lib/audit.ts`
- **Recommended action**: Add unit tests covering each `AuthResult.type` variant.

### TEST-04 [Major] `auth-or-token.test.ts` SA scope paths undertested
- **File**: `src/lib/auth-or-token.test.ts` lines 246-264
- **Problem**: No assertion that `hasSaTokenScope` was called; no test for scope-satisfied path.
- **Recommended action**: Add assertion + "scope satisfied" test case.

### TEST-05 [Major] `oauth-server.test.ts` missing 3 failure paths
- **File**: `src/lib/mcp/oauth-server.test.ts`
- **Problem**: `clientSecretHash` mismatch, `isActive: false`, `redirectUri` mismatch untested.
- **Recommended action**: Add 3 test cases.

### TEST-06 [Major] Plan-mandated test categories missing
- **Problem**: 7 test categories from the plan have no implementation (SA CRUD, API key backward compat, AccessRequest workflow, MCP stream errors, MCP round-trip, migration assertion, SA actorType integration).

### TEST-07 [Minor] `scope-parser.test.ts` missing team-scoped `scopeSatisfies` tests
- **Recommended action**: Add 2 test cases for team-scoped prefix match.

## Adjacent Findings
None — all findings fell cleanly within expert scopes.

## Resolution Status
Pending Round 1 fixes.
