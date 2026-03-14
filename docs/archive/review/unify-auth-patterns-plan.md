# Plan: Unify API Route Authentication Patterns (Item 5)

## Objective

Create a unified `checkAuth()` utility that replaces the two inconsistent authentication patterns (`authOrToken()` + manual `enforceAccessRestriction()` vs direct `auth()`) with a single, consistent API that handles auth, scope validation, and access restriction in one call.

## Requirements

### Functional
1. `checkAuth` must support both session-only and token-aware authentication
2. When tokens are supported, automatically enforce access restriction for non-session auth
3. Return a discriminated union `{ ok: true; auth: AuthResult } | { ok: false; response: NextResponse }` for ergonomic error handling
4. Preserve all existing auth behavior: session priority, Bearer prefix dispatch, scope validation, token revocation
5. `enforceAccessRestriction` integration as automatic behavior (not opt-in flag) for token-based auth

### Non-Functional
1. Zero behavior change for existing routes during migration (exception: `vault/status` scope_insufficient error code normalization — documented below)
2. Backward compatible: `authOrToken()` and `auth()` remain available during phased migration
3. Existing test suites must continue passing (minor updates allowed for mock wiring changes when auth function changes, e.g., `passwords/[id]` DELETE)

## Technical Approach

### API Design

```typescript
interface CheckAuthOptions {
  /** Required scope for token/API key access. Presence enables token-aware auth. */
  scope?: ExtensionTokenScope | ApiKeyScope;
  /** Allow token-based auth (Bearer tokens, API keys). Default: true when scope is set, false otherwise. */
  allowTokens?: boolean;
  /** Skip access restriction check for non-session auth. Default: false (always check). */
  skipAccessRestriction?: boolean;
}

type CheckAuthSuccess = { ok: true; auth: AuthResult };
type CheckAuthFailure = { ok: false; response: NextResponse };
type CheckAuthResult = CheckAuthSuccess | CheckAuthFailure;

export async function checkAuth(
  req: NextRequest,
  options?: CheckAuthOptions,
): Promise<CheckAuthResult>;
```

### Runtime Validation
- `{ scope, allowTokens: false }` → throw Error at dev time (invalid combination)
- `{ allowTokens: true }` without `scope` → allowed but emit `console.warn` in development (for API key management routes that check type manually)

### Behavior Matrix

| Options | Auth method | Access restriction |
|---------|------------|-------------------|
| `{}` or undefined | Session only (`auth()`) | No |
| `{ scope }` | `authOrToken(req, scope)` | Yes (non-session) |
| `{ allowTokens: true }` | `authOrToken(req)` | Yes (non-session) |
| `{ scope, skipAccessRestriction: true }` | `authOrToken(req, scope)` | No |
| `{ allowTokens: true, skipAccessRestriction: true }` | `authOrToken(req)` | No |

### Error Response Mapping

| Condition | HTTP Status | Error Code |
|-----------|-------------|------------|
| No auth | 401 | `UNAUTHORIZED` |
| Scope insufficient | 403 | `EXTENSION_TOKEN_SCOPE_INSUFFICIENT` |
| Access denied | 403 | `ACCESS_DENIED` |

## Implementation Steps

### Phase A: Create `checkAuth()` (this PR)

1. Create `src/lib/check-auth.ts` with `checkAuth()` function
2. Delegate to existing `authOrToken()` and `enforceAccessRestriction()` internally
3. Write comprehensive unit tests in `src/lib/check-auth.test.ts`:
   - Session-only mode: success, failure
   - Token-aware mode: session success, token success, API key success
   - Scope insufficient handling
   - Access restriction enforcement (called for non-session, skipped for session)
   - `skipAccessRestriction` option
   - `{ scope, allowTokens: false }` throws Error
   - `{ allowTokens: true }` without scope emits console.warn in dev
   - Token revocation delegation regression test
   - `_clearPolicyCache()` in `beforeEach` for access restriction tests
4. Add `src/lib/check-auth.ts`, `src/lib/auth-or-token.ts`, `src/lib/access-restriction.ts` to `vitest.config.ts` `coverage.include`
5. Create baseline tests for `api-keys` routes before migration:
   - `src/app/api/api-keys/route.test.ts`: unauthenticated → 401, session → 200/201, `type === "api_key"` → 401, extension token → 200
   - `src/app/api/api-keys/[id]/route.test.ts`: unauthenticated → 401, session → 200, extension token → 200

### Phase B: Pilot Migration (this PR)

Migrate 4 routes (5 route files, 9 handlers):

1. `src/app/api/vault/status/route.ts` — GET: `checkAuth(req, { scope: VAULT_UNLOCK_DATA })`
   - **Note**: scope_insufficient error code changes from `UNAUTHORIZED` to `EXTENSION_TOKEN_SCOPE_INSUFFICIENT` (normalization — update test assertion)
2. `src/app/api/vault/unlock/data/route.ts` — GET: `checkAuth(req, { scope: VAULT_UNLOCK_DATA })`
3. `src/app/api/api-keys/route.ts` — GET/POST: `checkAuth(req, { allowTokens: true, skipAccessRestriction: true })`
   - **Note**: These routes currently do NOT call `enforceAccessRestriction`. Use `skipAccessRestriction: true` to preserve existing behavior. API key self-management check (`type === "api_key"` → 401) remains in route handler.
4. `src/app/api/api-keys/[id]/route.ts` — DELETE: `checkAuth(req, { allowTokens: true, skipAccessRestriction: true })`
   - **Note**: Same as above — currently no access restriction, preserve that.
5. `src/app/api/passwords/[id]/route.ts` — GET/PUT: `checkAuth(req, { scope: PASSWORDS_READ/WRITE })`
   - **DELETE stays session-only**: `checkAuth(req)` — no token support. Extending DELETE to support tokens is a separate security decision requiring scope design (`PASSWORDS_DELETE`?) and `permanent=true` restriction analysis. Deferred to future PR.
   - **Test update required**: DELETE tests use `mockAuth` which must be updated to mock `checkAuth` instead. This is an accepted exception to "no test modifications".

For each route:
- Replace `authOrToken()` + scope check + access restriction block with single `checkAuth()` call
- Run existing tests, update mock wiring where auth function changes
- Verify no HTTP status code or error code changes (except vault/status normalization)

### Phase C/D: Deferred (future PRs)

- Phase C: Migrate remaining `authOrToken()` routes (passwords/route.ts, teams/*, v1/*)
- Phase D: Migrate `auth()` session-only routes (~115 routes) + deprecate old patterns
- Phase E: Design `PASSWORDS_DELETE` scope and token support for DELETE operations

## Testing Strategy

1. **Unit tests for `checkAuth`**: Mock `authOrToken` and `enforceAccessRestriction`, test all code paths including edge cases
2. **Baseline tests for api-keys routes**: Create before migration as regression guard
3. **Existing route tests**: Must pass after migration (mock wiring updates allowed for auth function changes)
4. **Access restriction test**: Verify `enforceAccessRestriction` is called for token auth, NOT called for session auth
5. **Smoke test**: Test that exercises `authOrToken` and `enforceAccessRestriction` as real modules (mock only DB layer: `prisma`, `auth`)
6. **`_clearPolicyCache()` in beforeEach** for any test exercising access restriction

## Considerations & Constraints

- **Token auth opt-in safety**: `allowTokens` defaults to `false` unless `scope` is provided. A route cannot accidentally become token-accessible. `{ scope, allowTokens: false }` throws at dev time.
- **`allowTokens: true` without scope**: Intentional exception for API key management routes that check auth type manually. Emit `console.warn` in development to flag potential misuse.
- **`skipAccessRestriction` guard**: Used only for routes that currently don't call `enforceAccessRestriction` (api-keys routes). Document all usages in code comments explaining why.
- **No new audit logging**: `checkAuth` delegates to `authOrToken()` and `enforceAccessRestriction()`, which already emit audit logs on denial.
- **CSRF/session handling**: `checkAuth` delegates to Auth.js `auth()` for session resolution. CSRF protection is handled separately by `assertOrigin()` in each route handler.
- **Token revocation**: Delegated to `authOrToken()` → `validateExtensionToken()` / `validateApiKey()`. Existing revocation tests in `auth-or-token.test.ts` provide coverage. Add one regression test in `check-auth.test.ts`.
- **`passwords/[id]` DELETE**: Stays session-only in this PR. Token support deferred to Phase E with proper scope design.
- **API key routes**: `skipAccessRestriction: true` preserves existing behavior (no access restriction). API key self-management check stays in route handler.
- **vault/status error code normalization**: `scope_insufficient` response changes from `UNAUTHORIZED` to `EXTENSION_TOKEN_SCOPE_INSUFFICIENT`. This is a minor breaking change for extension clients checking error codes — accepted as a correctness fix.
- SCIM routes use their own `validateScimToken()` — excluded from `checkAuth` scope.
- V1 API routes — included in future Phase C migration.
