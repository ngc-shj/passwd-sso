# Plan: codebase-audit-fixes

## Objective

Address actionable findings from the codebase security/quality audit. Focus on input validation gaps, security header hygiene, and test coverage improvements.

## Requirements

### Functional
- All cursor-based pagination endpoints must validate cursor format before reaching Prisma
- MCP OAuth authorize endpoint must validate redirect_uri before any redirect (both authenticated and unauthenticated paths)
- Security headers must follow modern best practices

### Non-functional
- No breaking changes to existing API contracts
- All existing tests must continue to pass
- Production build must succeed

## Technical Approach

### 1. Cursor Pagination Validation (11 routes, 2 centralization points)

Add cursor format validation before Prisma queries. Accept both UUIDv4 and CUID v1 formats.

**Centralization strategy:**
- `src/lib/audit-query.ts` (`parseAuditLogParams`) — shared by all audit log routes. Adding validation here covers 7 routes at once.
- Remaining 4 routes need individual updates.

**Error handling contract for parseAuditLogParams:**
- `parseAuditLogParams` returns `cursor: null` when the cursor is invalid (instead of throwing). This avoids changes to 7 call sites.
- The function signature changes: `cursor: string | null` remains, but invalid cursors are silently nullified.
- A new `cursorInvalid: boolean` field is added to `AuditLogParams` so callers can distinguish "no cursor" from "invalid cursor" and return 400.
- Alternative considered: throw approach (rejected — requires catch blocks in 7 consumers).

**Cursor format:**
- Accept: UUIDv4 (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`) and CUID v1 (`c` prefix, 25 alphanumeric chars)
- Regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^c[0-9a-z]{24}$/i`
- Add as `CURSOR_ID_RE` to `src/lib/validations/common.ts`

**Files to modify:**
- `src/lib/validations/common.ts` — add `CURSOR_ID_RE` regex pattern
- `src/lib/audit-query.ts` — validate cursor in `parseAuditLogParams`, add `cursorInvalid` field
- `src/app/api/notifications/route.ts` — individual cursor validation
- `src/app/api/share-links/mine/route.ts` — individual cursor validation
- `src/app/api/share-links/[id]/access-logs/route.ts` — individual cursor validation
- `src/app/api/directory-sync/[id]/logs/route.ts` — individual cursor validation + add missing catch block

**Routes covered via audit-query.ts centralization:**
- `src/app/api/audit-logs/route.ts`
- `src/app/api/audit-logs/download/route.ts`
- `src/app/api/teams/[teamId]/audit-logs/route.ts`
- `src/app/api/teams/[teamId]/audit-logs/download/route.ts`
- `src/app/api/tenant/audit-logs/route.ts`
- `src/app/api/tenant/audit-logs/download/route.ts`
- `src/app/api/tenant/breakglass/[id]/logs/route.ts`

**Implementation invariant:** The existing `...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})` pattern in each consumer MUST be preserved. Validation only gates the cursor value; it does not change how Prisma receives it.

### 2. MCP Authorize redirect_uri Validation (Both Paths)

Add redirect_uri validation to the authorize route for BOTH authenticated and unauthenticated flows, before any redirect occurs.

**Current flow (problematic):**
1. Unauthenticated → redirect to login (no redirect_uri validation)
2. Authenticated → redirect to consent page (no redirect_uri validation)
3. Consent page POST → DB lookup + redirect_uri validation (final defense)

**Proposed flow:**
1. ALL requests → validate required params (clientId, redirectUri present)
2. ALL requests → DB lookup: find client by clientId, check redirectUri in registered URIs
3. Validation fails → return 400 `{ error: "invalid_request" }` (generic, anti-enumeration)
4. Validation passes + unauthenticated → redirect to login (existing flow)
5. Validation passes + authenticated → redirect to consent page (existing flow)

**Anti-enumeration:** Return identical `{ error: "invalid_request" }` for: client not found, redirect_uri mismatch, missing required params.

**Consent page interaction:** The consent page (`/[locale]/mcp/authorize/page.tsx`) already performs its own DB lookup + redirect_uri check. After adding validation to the API route, the consent page's check becomes redundant but serves as defense-in-depth. Do NOT remove the consent page validation.

**RLS:** Use `withBypassRls(prisma, fn, BYPASS_PURPOSE.AUTH_FLOW)` for the pre-auth DB lookup.

**Files to modify:**
- `src/app/api/mcp/authorize/route.ts` — add validation before both redirect paths

**Files to create:**
- `src/__tests__/api/mcp/authorize.test.ts` — automated tests for the authorize route

### 3. Security Header Cleanup

**Files to modify:**
- `next.config.ts` — remove X-XSS-Protection header
- `src/proxy.ts` — remove `include_subdomains` from Report-To header

**Approach:**
- Remove `X-XSS-Protection: 1; mode=block` entirely (deprecated; CSP is the replacement)
- Remove `include_subdomains: true` from Report-To JSON (no subdomains in use; prevents cross-tenant CSP report leakage in multi-tenant deployments)

### 4. Test Coverage Improvements

**Files to modify:**
- `src/lib/audit-query.test.ts` — add cursor validation test cases to existing file (NOT new file)

**Files to create:**
- `src/__tests__/api/mcp/authorize.test.ts` — MCP authorize route handler tests
- `cli/src/__tests__/integration/agent-decrypt-ipc.test.ts` — test forkDaemon/runDaemonChild IPC flow via real process fork (NOT mocked IPC — the existing unit test already covers mocked scenarios)

**Out of scope (documented tradeoffs, not bugs):**
- WebAuthn E2E tests — requires platform authenticator emulation (separate initiative)
- HKDF zero salt — documented and accepted in crypto-domain-ledger.md
- p1363ToDer 1-byte sequence length — P-256 only, documented
- session-crypto.ts ephemeral key singleton — SW lifecycle managed by browser
- proxy.ts session cache multi-worker gap — documented, Redis migration planned
- withBypassRls call count (211) — structural, managed by CI guard

## Implementation Steps

1. Add `CURSOR_ID_RE` regex to `src/lib/validations/common.ts`
2. Add cursor validation + `cursorInvalid` field to `parseAuditLogParams` in `src/lib/audit-query.ts`
3. Update 7 audit log route consumers to check `cursorInvalid` and return 400
4. Update 4 non-audit cursor routes (notifications, share-links/mine, share-links/access-logs, directory-sync/logs)
5. Add catch block to directory-sync logs route
6. Add early redirect_uri validation to MCP authorize route (both auth paths)
7. Remove X-XSS-Protection from next.config.ts
8. Remove include_subdomains from Report-To in proxy.ts
9. Add cursor validation test cases to existing audit-query.test.ts
10. Create MCP authorize route tests
11. Create agent-decrypt IPC integration test (real process fork)
12. Run lint, tests, and production build

## Testing Strategy

- Cursor validation: add cases to existing `src/lib/audit-query.test.ts` (valid UUID, valid CUID, invalid strings, empty, null)
- MCP authorize: new `src/__tests__/api/mcp/authorize.test.ts` covering:
  - Unauthenticated + valid params → login redirect
  - Unauthenticated + missing redirect_uri → 400
  - Unauthenticated + invalid redirect_uri → 400 (same error as missing)
  - Unauthenticated + invalid client_id → 400 (same error)
  - Authenticated + valid params → consent redirect
  - Authenticated + invalid redirect_uri → 400
- Agent decrypt IPC: real process fork test in `cli/src/__tests__/integration/agent-decrypt-ipc.test.ts`
- All existing test suites must remain green
- Production build verification

## Considerations & Constraints

- Cursor validation regex accepts both UUIDv4 and CUID v1 to prevent regression
- MCP authorize early validation requires a DB query before authentication — acceptable for security/UX
- Anti-enumeration: generic error prevents attackers from discovering valid client IDs
- Consent page validation remains as defense-in-depth (not removed)
- Removing X-XSS-Protection may affect IE11 users — IE11 is not a supported browser
- Agent decrypt IPC test requires process forking in test environment — may need special vitest config

## User Operation Scenarios

### Cursor pagination with invalid cursor
1. Client sends `GET /api/notifications?cursor=not-a-uuid`
2. Server validates cursor format → invalid (not UUID or CUID)
3. Server returns 400 `{ error: "INVALID_CURSOR" }`
4. No database query is executed

### Cursor pagination with CUID v1 cursor (backward compatibility)
1. Client sends `GET /api/notifications?cursor=cjld2cyuq0000t3rmniod1foy`
2. Server validates cursor format → valid (CUID v1)
3. Prisma query executes normally
4. Results returned as before

### MCP authorize with invalid redirect_uri (unauthenticated)
1. Attacker crafts URL: `/api/mcp/authorize?client_id=valid&redirect_uri=https://evil.com&...`
2. User clicks link (unauthenticated)
3. Server checks clientId + redirect_uri against DB → invalid
4. Server returns 400 `{ error: "invalid_request" }` — generic message, no client ID leak
5. User never reaches login page

### MCP authorize with invalid redirect_uri (authenticated)
1. Authenticated user navigates to authorize URL with invalid redirect_uri
2. Server checks clientId + redirect_uri against DB → invalid
3. Server returns 400 `{ error: "invalid_request" }`
4. User never reaches consent page

### MCP authorize with valid params (unauthenticated)
1. User navigates to `/api/mcp/authorize?client_id=valid&redirect_uri=https://app.com/callback&...`
2. Server validates redirect_uri → valid
3. Server redirects to login page with callbackUrl
4. After login, flow continues normally to consent page
