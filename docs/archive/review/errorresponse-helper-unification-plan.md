# Plan: errorResponse Helper Unification

## Objective

Unify all API error responses to use `errorResponse` / `unauthorized` / `notFound` / `forbidden` / `validationError` / `rateLimited` helpers from `src/lib/api-response.ts`. Register missing error codes in `API_ERROR`. Eliminate direct `NextResponse.json({ error: ... })` calls in non-OAuth routes.

## Scope

### In scope
- 16 route files with direct `NextResponse.json` error calls
- `TenantAuthError` catch blocks using `NextResponse.json({ error: err.message })` (6 instances in 2 files)
- New `API_ERROR` codes + i18n keys
- Test updates for changed error strings

### Out of scope
- **MCP/OAuth routes** (`/api/mcp/revoke`, `/api/mcp/authorize`, `/api/mcp/token`, `/api/mcp/register`) — RFC standard codes (`invalid_request`, `access_denied`, etc.)
- **Exception**: `/api/mcp/authorize/consent/route.ts` L15 (`INVALID_ORIGIN`) and L22 (`unauthorized`) — these two non-OAuth errors ARE in scope
- Files with no error responses

## New API_ERROR Codes

### Already existing (reuse)
`UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN`, `INVALID_JSON`, `INVALID_PASSPHRASE`, `VALIDATION_ERROR`, `SERVICE_UNAVAILABLE`, `INVALID_ORIGIN`, `SESSION_NOT_FOUND`, `RATE_LIMIT_EXCEEDED`, `MCP_CLIENT_NAME_CONFLICT`

### New codes to add to `src/lib/api-error-codes.ts`

| Code | Current string literal | Used in |
|------|----------------------|---------|
| `INTERNAL_ERROR` | `"INTERNAL_ERROR"` | extension/token, extension/token/refresh |
| `NO_TENANT` | `"No tenant"` | vault/delegation, user/mcp-tokens |
| `MCP_CLIENT_LIMIT_EXCEEDED` | `"MCP_CLIENT_LIMIT_EXCEEDED"` | tenant/mcp-clients |
| `INVALID_SESSION` | `"Invalid session ID"` | vault/delegation/[id] |
| `MCP_TOKEN_NOT_FOUND` | `"MCP token not found or expired"` | vault/delegation |
| `MCP_TOKEN_SCOPE_INSUFFICIENT` | `"MCP token does not have credentials:list or credentials:use scope"` | vault/delegation |
| `DELEGATION_STORE_FAILED` | `"Failed to store delegation entries"` | vault/delegation |
| `DELEGATION_ENTRIES_NOT_FOUND` | `"Some entries not found or not accessible"` | vault/delegation |

Each code requires: `API_ERROR` entry + `API_ERROR_I18N` mapping + `messages/{en,ja}/ApiErrors.json` i18n key.

Update `src/lib/api-error-codes.test.ts` code count.

## Target Files

### Group A: Mixed usage (already import some helpers)

| # | File | Changes |
|---|------|---------|
| 1 | `src/app/api/extension/token/route.ts` | L20: `"INTERNAL_ERROR"` → `errorResponse(API_ERROR.INTERNAL_ERROR, 500)` |
| 2 | `src/app/api/extension/token/refresh/route.ts` | L102: same |
| 3 | `src/app/api/travel-mode/disable/route.ts` | L96: `"INVALID_PASSPHRASE"` → `errorResponse(API_ERROR.INVALID_PASSPHRASE, 401)` |
| 4 | `src/app/api/tenant/mcp-clients/[id]/route.ts` | L39,78,150: `"Unauthorized"` → `unauthorized()`; L68,93,165: `"Not found"` → `notFound()`; L99: `"Invalid JSON"` → `errorResponse(API_ERROR.INVALID_JSON, 400)`; L103: `"Validation error"` → `validationError(...)`; L46,85,157: `TenantAuthError` → `errorResponse(err.message as ApiErrorCode, err.status)` |
| 5 | `src/app/api/tenant/mcp-clients/route.ts` | L35,104: `"Unauthorized"` → `unauthorized()`; L120: `"Invalid JSON"` → `errorResponse(API_ERROR.INVALID_JSON, 400)`; L125: `"Validation error"` → `validationError(...)`; L136: `"MCP_CLIENT_LIMIT_EXCEEDED"` → `errorResponse(API_ERROR.MCP_CLIENT_LIMIT_EXCEEDED, 409, { message })`; L42,111: `TenantAuthError` → `errorResponse(err.message as ApiErrorCode, err.status)` |
| 6 | `src/app/api/tenant/access-requests/route.ts` | L116-118: `API_ERROR.*` → `errorResponse(...)` or `forbidden()`; L143,179: → `errorResponse(API_ERROR.SA_NOT_FOUND, 404)` |
| 7 | `src/app/api/tenant/policy/route.ts` | L172: → `errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "..." })` |

### Group B: No helper imports

| # | File | Changes |
|---|------|---------|
| 8 | `src/app/api/admin/rotate-master-key/route.ts` | L43: → `unauthorized()` |
| 9 | `src/app/api/maintenance/dcr-cleanup/route.ts` | L32: → `unauthorized()` |
| 10 | `src/app/api/maintenance/purge-history/route.ts` | L34: → `unauthorized()` |
| 11 | `src/app/api/vault/delegation/route.ts` | L63,240,329: → `unauthorized()`; L69,246,335: `"No tenant"` → `errorResponse(API_ERROR.NO_TENANT, 403)`; L76: `"Rate limit exceeded"` → `rateLimited()`; L85: `"Invalid request"` → `validationError(...)`; L109: → `errorResponse(API_ERROR.MCP_TOKEN_NOT_FOUND, 404)`; L118: scope error → `errorResponse(API_ERROR.MCP_TOKEN_SCOPE_INSUFFICIENT, 403)`; L156: → `errorResponse(API_ERROR.DELEGATION_ENTRIES_NOT_FOUND, 404)`; L212: → `errorResponse(API_ERROR.DELEGATION_STORE_FAILED, 503)` |
| 12 | `src/app/api/vault/delegation/[id]/route.ts` | L25: → `unauthorized()`; L31: → `errorResponse(API_ERROR.NO_TENANT, 403)`; L36: → `errorResponse(API_ERROR.INVALID_SESSION, 400)`; L41: → `errorResponse(API_ERROR.SESSION_NOT_FOUND, 404)` |
| 13 | `src/app/api/user/mcp-tokens/[id]/route.ts` | L22: → `errorResponse(API_ERROR.NO_TENANT, 403)`; L115: → `notFound()` |
| 14 | `src/app/api/user/mcp-tokens/route.ts` | L22,79: → `errorResponse(API_ERROR.NO_TENANT, 403)` |
| 15 | `src/app/api/directory-sync/[id]/logs/route.ts` | L22-25: → `unauthorized()`; L37-39: → `forbidden()`; L52-54: → `notFound()`; L66,98: → `errorResponse(API_ERROR.INVALID_CURSOR, 400)` |
| 16 | `src/app/api/notifications/route.ts` | L19-22: → `unauthorized()`; L28,53-56: → `errorResponse(API_ERROR.INVALID_CURSOR, 400)` |

### Group C exception

| # | File | Changes |
|---|------|---------|
| 17 | `src/app/api/mcp/authorize/consent/route.ts` | L15: `"INVALID_ORIGIN"` → `errorResponse(API_ERROR.INVALID_ORIGIN, 403)`; L22: `"unauthorized"` → `unauthorized()` |

## Test Updates Required

### Error string changes requiring test assertion updates

| Test file | Line | Current assertion | New assertion |
|-----------|------|-------------------|---------------|
| `vault/delegation/route.test.ts` | L162 | `"Unauthorized"` | `"UNAUTHORIZED"` |
| `vault/delegation/route.test.ts` | L170 | `"No tenant"` | `"NO_TENANT"` |
| `vault/delegation/route.test.ts` | L185 | `"Invalid request"` | `"VALIDATION_ERROR"` |
| `vault/delegation/route.test.ts` | L223 | `/not found or expired/i` | `"MCP_TOKEN_NOT_FOUND"` |
| `vault/delegation/route.test.ts` | L234 | `/credentials:list/` | `"MCP_TOKEN_SCOPE_INSUFFICIENT"` |
| `vault/delegation/route.test.ts` | L252 | `/not found or not accessible/i` | `"DELEGATION_ENTRIES_NOT_FOUND"` |
| `vault/delegation/route.test.ts` | L328 | `/Failed to store/i` | `"DELEGATION_STORE_FAILED"` |
| `vault/delegation/[id]/route.test.ts` | L58 | `"Unauthorized"` | `"UNAUTHORIZED"` |
| `vault/delegation/[id]/route.test.ts` | L66 | `"No tenant"` | `"NO_TENANT"` |
| `vault/delegation/[id]/route.test.ts` | L73 | `"Invalid session ID"` | `"INVALID_SESSION"` |
| `vault/delegation/[id]/route.test.ts` | L81 | `/not found or already revoked/i` | `"SESSION_NOT_FOUND"` |
| `user/mcp-tokens/route.test.ts` | L259 | `"No tenant"` | `"NO_TENANT"` |
| `mcp/authorize/consent/route.test.ts` | TBD | `"INVALID_ORIGIN"` | no change (already uppercase) |
| `mcp/authorize/consent/route.test.ts` | TBD | `"unauthorized"` | `"UNAUTHORIZED"` |
| `tenant/mcp-clients/route.test.ts` | TBD | check for `"Unauthorized"`, `"Invalid JSON"` assertions |
| `tenant/mcp-clients/[id]/route.test.ts` | TBD | check for `"Unauthorized"`, `"Not found"` assertions |

## Implementation Steps

1. Add 8 new codes to `API_ERROR` + `API_ERROR_I18N` + i18n JSONs + test count
2. Group A (7 files): Replace direct calls with helpers, add missing imports
3. Group B (8 files): Add imports + replace direct calls
4. Group C (1 file): Replace 2 non-OAuth error calls
5. TenantAuthError (2 files, 6 instances): Replace `NextResponse.json({ error: err.message })` with `errorResponse(err.message as ApiErrorCode, err.status)`
6. Update all test assertions listed above
7. Run `npx vitest run` + `npx next build`

## Testing Strategy

- All existing tests must pass after updating assertions
- `api-error-codes.test.ts` code count must be updated (+8)
- Response body shape is identical (`{ error: CODE }`) — no breaking change for API consumers using status codes
- Error string values DO change (e.g., `"Unauthorized"` → `"UNAUTHORIZED"`) — tests must be updated

## Considerations & Constraints

- `errorResponse` returns `{ error: CODE, ...details }` — same shape as `NextResponse.json({ error: CODE })`
- Custom messages (e.g., `MCP_CLIENT_LIMIT_EXCEEDED` with `message` field) use `errorResponse(code, status, { message })` which spreads details
- `TenantAuthError.message` is already an `ApiErrorCode` value — casting with `as ApiErrorCode` is safe
- `"Session not found or already revoked"` maps to existing `SESSION_NOT_FOUND` code — the human-readable message moves to i18n
- `"Failed to store delegation entries"` → `DELEGATION_STORE_FAILED` with status 503 (uses existing `SERVICE_UNAVAILABLE` concept but with specific code for delegation context)
