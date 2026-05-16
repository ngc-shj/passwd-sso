# Plan: fix-bearer-token-scope-gates

## Project context

- **Type**: web app (multi-tenant password manager, Next.js 16 App Router)
- **Test infrastructure**: unit + integration + E2E (Vitest + Playwright) + CI/CD (GitHub Actions)
- Real-DB integration tests via `npm run test:integration`; production build verification via `npx next build`
- Pre-PR script `scripts/pre-pr.sh` exists and SHOULD be run before push

## Background

External review (ChatGPT) flagged five gaps in Bearer-token scope enforcement. All five have been
independently reproduced in the current `main` codebase (no recent regression — pre-existing surface).
The common root cause is `checkAuth({ allowTokens: true })` and `authOrToken(req)` being callable
without a `scope` argument: the function performs auth-type filtering after token validation, but a
holder of any token with a `userId` reaches the handler. The handler then mixes "user's identity
permission" with "token's delegated permission", which is the structural defect we are closing.

Confirmed call sites (from `grep`):

| # | Site | Current shape |
|---|------|---------------|
| 1 | [src/app/api/api-keys/route.ts:29](src/app/api/api-keys/route.ts#L29) (GET list) | `checkAuth(req, { allowTokens: true })`, rejects `api_key`/`mcp_token` only |
| 2 | [src/app/api/api-keys/route.ts:70](src/app/api/api-keys/route.ts#L70) (POST create) | same + step-up only for `session` |
| 3 | [src/app/api/api-keys/[id]/route.ts:16](src/app/api/api-keys/%5Bid%5D/route.ts#L16) (DELETE revoke) | same |
| 4 | [src/app/api/tenant/access-requests/route.ts:106](src/app/api/tenant/access-requests/route.ts#L106) (POST) | `authOrToken(req)` no scope, admin branch accepts any token whose `userId` is admin |
| 5 | [src/app/api/vault/delegation/check/route.ts:30](src/app/api/vault/delegation/check/route.ts#L30) (GET) | `authOrToken(request)` no scope |
| 6 | [src/lib/services/team-password-service.ts:272](src/lib/services/team-password-service.ts#L272) / [:420](src/lib/services/team-password-service.ts#L420) | `tagIds.map((id) => ({ id }))` without `teamId` ownership check |
| 7 | [src/lib/auth/session/check-auth.ts:57-62](src/lib/auth/session/check-auth.ts#L57-L62) | `allowTokens && !scope` warns in dev, allowed in prod |
| 8 | [src/lib/services/team-password-service.ts:399-422](src/lib/services/team-password-service.ts#L399-L422) and [src/app/api/passwords/[id]/route.ts:174-175](src/app/api/passwords/%5Bid%5D/route.ts#L174-L175) | `itemKeyVersion` / `teamKeyVersion` / `aadVersion` (team) and `keyVersion` / `aadVersion` (personal) can change without `encryptedBlob` — AAD mismatches existing ciphertext, entry becomes undecryptable |
| 9 | [src/lib/http/parse-body.ts:57](src/lib/http/parse-body.ts#L57) | `await req.json()` with no `content-length` cap; Zod string maxes only apply post-parse |
| 10 | [src/app/api/tenant/access-requests/[id]/deny/route.ts](src/app/api/tenant/access-requests/%5Bid%5D/deny/route.ts) | No `requireRecentCurrentAuthMethod` step-up, inconsistent with sibling `approve` which has it at line 46 |

Out-of-scope but noted: [src/app/api/v1/openapi.json/route.ts:14](src/app/api/v1/openapi.json/route.ts#L14)
uses `authOrToken(req)` without scope, but only inside an `if (!isPublic)` branch as an
"any-auth-token gate" — the intent is explicit ("any valid auth"), not a missed scope check.
We add an inline comment but do NOT change behavior.

## Objective

Close the Bearer-token scope-boundary gap so that:

1. Long-lived credential issuance (API key create/list/revoke) is reachable only via interactive
   session + recent re-auth — short-lived tokens cannot be exchanged for long-lived ones.
2. Tenant-admin operations (access-request creation on behalf of a SA) require explicit session
   auth — admin's `userId` is no longer sufficient when carried by an arbitrary token.
3. Authorization oracles (delegation check) require an explicit scope rather than any-token-with-userId.
4. Service/Team data-layer mutations validate cross-team ownership before connecting referenced rows.
5. The `checkAuth({ allowTokens: true })` without-scope footgun becomes a runtime error, making
   every future caller declare intent explicitly.
6. Cryptographic version metadata (`itemKeyVersion`, `keyVersion`, `teamKeyVersion`, `aadVersion`)
   stored alongside ciphertext cannot be updated without re-encrypting the blob — closing an
   "authorized editor breaks the entry" DoS vector that bypasses C5's authorization check.
7. JSON request bodies are length-capped at the boundary so an unauthenticated attacker cannot
   force the server to allocate arbitrary-size buffers before Zod sees the payload.
8. The deny path on access requests requires the same recent re-auth step-up that approve already
   requires, removing inconsistent friction across approve/deny.

## Requirements

### Functional

- Extension Token holders MUST NOT be able to create, list, or revoke API keys.
- API key / Extension Token / MCP Token holders MUST NOT be able to create tenant access requests
  on behalf of a Service Account via the admin path. SA self-service via `sa_` token with
  `access-request:create` scope is preserved.
- The `delegation/check` endpoint MUST accept only token types whose role legitimately requires
  delegation introspection (MCP tokens and SA tokens), via a dedicated scope.
- `createTeamPassword` / `updateTeamPassword` MUST reject any `tagIds` whose tags belong to a
  different team within the same tenant. Same shape rule already exists for `teamFolderId`.
- `checkAuth({ allowTokens: true })` MUST throw at runtime when called without a `scope`.
- `updateTeamPassword` MUST reject any change to `itemKeyVersion`, `teamKeyVersion`, or
  `aadVersion` unless the same call carries a new `encryptedBlob` (i.e. `isFullUpdate === true`).
- The personal `PATCH /api/passwords/[id]` MUST reject any change to `keyVersion` or `aadVersion`
  unless the same call carries a new `encryptedBlob`.
- `parseBody` MUST reject requests whose `content-length` header exceeds a configurable byte cap
  before invoking `req.json()`. The default cap is small (e.g. 1 MB); bulk-import-style routes
  override via an explicit option.
- `POST /api/tenant/access-requests/[id]/deny` MUST call `requireRecentCurrentAuthMethod` after
  session validation, matching the sibling `approve` route.

### Non-functional

- All existing E2E flows must continue to pass — extension flows do not depend on extension-token-
  initiated API-key management (verified by inspecting `extension/` and existing tests; absence of
  failure here is a Phase 2 verification step).
- No new dependency. No new env var.
- No database migration.
- Audit log emission is unchanged in shape for all affected endpoints (this is a pure auth-gate
  change).

## Technical approach

### Strategy

**Scope-or-session is the default; allow-token-without-scope is a runtime error.**

After this plan:
- `checkAuth(req)` → session only (no change)
- `checkAuth(req, { scope: ... })` → token-aware, scope-validated (no change)
- `checkAuth(req, { allowTokens: true })` (no scope) → **throws** at runtime
- `authOrToken(req)` (no scope) → caller MUST be either session-only path or a deliberate "any
  valid auth" gate where a new inline comment justifies the absence of scope

### Per-finding fix

1. **api-keys POST**: drop `allowTokens: true`. Use `checkAuth(req)` (session only).
   `requireRecentCurrentAuthMethod` becomes unconditional (no `if session` branch).
2. **api-keys GET**: drop `allowTokens: true`. Use `checkAuth(req)` (session only). Rationale:
   listing one's own API keys is a settings-page operation; the browser session is the right
   primary control. No legitimate scenario requires extension token to enumerate keys.
3. **api-keys DELETE [id]**: drop `allowTokens: true`. Use `checkAuth(req)` (session only). Same
   rationale as GET — revoking is a settings-page operation.
4. **access-requests POST admin branch**: replace `authOrToken(req)` with a sequence:
   - If `Authorization: Bearer sa_*` is present → SA self-service path (as today, requires
     `ACCESS_REQUEST_CREATE` scope).
   - Otherwise → require session via `auth()`. Reject any non-session non-SA bearer.
   This intentionally does NOT add a new `API_KEY_SCOPE.SERVICE_ACCOUNT_MANAGE` — admin operations
   on machine identities should not be reachable via a long-lived API key. If a future use case
   demands it, that addition is a separate plan.
5. **delegation/check GET**: tighten to MCP token + session only. The CLI agent that performs
   decrypt holds an MCP token (issued via DCR + PKCE OAuth flow). Add
   `MCP_SCOPE.DELEGATION_CHECK = "delegation:check"` and use `authOrToken(request, "delegation:check")`.
   Session continues to be accepted (no scope check). SA tokens are intentionally NOT supported
   in this PR — they lack `userId` (see Review Round 1, F-2) and the delegation model is
   MCP-client-centric (`mcpAccessToken.mcpClient` join in the lookup). If SA-token decrypt
   becomes a real use case, a follow-up PR adds a parallel `serviceAccountId`-keyed lookup path.
6. **TeamTag tagIds validation**: in both `createTeamPassword` and `updateTeamPassword`, after
   resolving the team and folder, fetch
   `count = await prisma.teamTag.count({ where: { id: { in: tagIds }, teamId } })` and reject when
   `count !== tagIds.length`. Reuse existing `API_ERROR.NOT_FOUND` (404). Note from Review Round
   1 F-1: `API_ERROR.TAG_NOT_FOUND` does NOT exist in `api-error-codes.ts` — the closest existing
   code is `NOT_FOUND` (404). Status code aligns with REST conventions for "referenced resource
   not present in this scope". The existing personal-vault tag validation in
   `src/app/api/passwords/[id]/route.ts:124-132` returns `validationError` (400); we intentionally
   diverge to 404 here because the bypass attempt is identity-via-id rather than malformed input.
7. **check-auth meta**: replace the dev-only `console.warn` with a runtime `throw new Error(...)`
   so any caller of `checkAuth({ allowTokens: true })` without `scope` fails immediately, in any
   environment. Existing callers (already fixed in 1-3 above) become the only callers of
   `{ allowTokens: true }` without scope — after this PR there are none, so the throw is a permanent
   guardrail.

### Per-finding fix (added)

8. **Cryptographic version metadata integrity**:
   - In `updateTeamPassword`: compute `versionMetadataChanged = (itemKeyVersion ?? existing) !== existing OR (teamKeyVersion !== existing.teamKeyVersion when provided) OR (aadVersion !== existing.aadVersion when provided)`. If `versionMetadataChanged && !isFullUpdate` → throw `API_ERROR.ITEM_KEY_VERSION_DOWNGRADE` reused as the closest existing error code (409 Conflict).
   - In `src/app/api/passwords/[id]/route.ts` PATCH: similarly reject `keyVersion`/`aadVersion`
     changes when `encryptedBlob === undefined`. Use `API_ERROR.VALIDATION_ERROR` (400) since
     personal vault has no specific error code for this case.
   - Reuse existing error codes — no new entries in `api-error-codes.ts`.
9. **JSON body size cap in `parseBody`** (CORRECTED from Round 1 — X-1, S-2, F-3):
   - Add `MAX_JSON_BODY_BYTES = 1_048_576` (1 MB) constant in `src/lib/validations/common.server.ts`
     (sits next to existing `METADATA_MAX_BYTES`).
   - Extend `parseBody` signature: `parseBody<T>(req, schema, options?: { maxBytes?: number })`.
   - Before `req.json()`, read `content-length` header. If present and `> options.maxBytes ?? MAX_JSON_BODY_BYTES`, return `errorResponse(API_ERROR.PAYLOAD_TOO_LARGE)`. If header is absent, skip the check — see "platform backstop" below.
   - **`API_ERROR.PAYLOAD_TOO_LARGE` ALREADY EXISTS** at `src/lib/http/api-error-codes.ts:71` with status 413 and i18n key `fileTooLarge` (attachment-context message). Do NOT add it. DO remap the i18n key: change `API_ERROR_I18N.PAYLOAD_TOO_LARGE` from `"fileTooLarge"` to a new `"payloadTooLarge"` key, and add `"payloadTooLarge"` translations to `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json` (Japanese: `リクエストボディが大きすぎます`). Re-run `api-errors-i18n-coverage.test.ts` to confirm.
   - **Stream-byte-counting in `parseBody`** (Round 2 S-2R — CORRECTED from Round 1 S-2): Next.js 16 App Router has NO platform body cap for route handlers. `experimental.serverActions.bodySizeLimit` applies only to Server Actions; `experimental.proxyClientMaxBodySize` applies only to middleware proxy stream cloning. Neither caps plain App Router `req.json()`. The Round 1 "platform backstop" approach is architecturally infeasible. **The correct fix is to read `req.body` as a stream in `parseBody` and abort when the accumulated byte count exceeds the cap, regardless of whether `Content-Length` is present**. Sketch:
     ```ts
     // parse-body.ts
     async function readCapped(req: NextRequest, maxBytes: number): Promise<string | { tooLarge: true }> {
       const reader = req.body?.getReader();
       if (!reader) return "";
       let total = 0;
       const chunks: Uint8Array[] = [];
       while (true) {
         const { done, value } = await reader.read();
         if (done) break;
         if (value) {
           total += value.length;
           if (total > maxBytes) {
             await reader.cancel();
             return { tooLarge: true };
           }
           chunks.push(value);
         }
       }
       return new TextDecoder().decode(Buffer.concat(chunks));
     }
     // then JSON.parse(text) inside parseBody
     ```
     Content-Length is still pre-checked (cheap reject) but the stream-counting is the authoritative guard. Removes the chunked-TE bypass.
   - **Migrate 21 routes calling `req.json()` / `request.json()` directly** (Round 1 F-3 + Round 2 F-R2-1 expansion):
     The Round 1 grep `grep -rn "await req\.json\(\)" src/` produced 18 hits. Round 2 re-grep `grep -rn "\.json()" src/app/api/ | grep -v test | grep -v parse-body` found 21 production hits including 3 missed by the `req\.` prefix and 1 using `request.json()` instead of `req.json()`. ALL 21 must be migrated:
     - **Default 1 MB cap** — small payloads:
       - `src/app/api/auth/passkey/verify/route.ts:59`
       - `src/app/api/scim/v2/Users/route.ts:129`, `Users/[id]/route.ts:58,129`
       - `src/app/api/scim/v2/Groups/route.ts:143`, `Groups/[id]/route.ts:49,110`
       - `src/app/api/extension/token/exchange/route.ts:58`
       - `src/app/api/mobile/cache-rollback-report/route.ts:94`
       - `src/app/api/mobile/token/route.ts:109`
       - `src/app/api/mcp/revoke/route.ts:45`
       - `src/app/api/mcp/route.ts:29` (MCP JSON-RPC)
       - `src/app/api/mcp/token/route.ts:31`
       - `src/app/api/tenant/policy/route.ts:179`
       - `src/app/api/tenant/breakglass/route.ts:50`
       - `src/app/api/csp-report/route.ts:80` (Round 2 F-R2-1 — newly identified)
       - `src/app/api/internal/audit-emit/route.ts:62` (Round 2 F-R2-1 — newly identified)
     - **Explicit override** (legitimately larger payloads):
       - `src/app/api/vault/rotate-key/route.ts:110` — `request.json()` (NOTE: `request.` not `req.`; Round 2 F-R2-1). Set `{ maxBytes: 16 * 1024 * 1024 }`. Re-encrypts entire personal vault.
       - `src/app/api/passwords/[id]/attachments/[attachmentId]/migrate/route.ts:63` (Round 2 F-R2-1 — newly identified). Inherit existing `ATTACHMENT_MIGRATE_PAYLOAD_MAX` (`MAX_FILE_SIZE * 2` = 20 MB).
     - **SPECIAL CASE — non-mechanical migration** (Round 2 T-R2-2 and T-R2-3 — these routes have semantics that `parseBody`'s default 400 error path would change):
       - `src/app/api/webauthn/authenticate/options/route.ts:44` — uses `try/catch` around `req.json()` and silently falls back to PRF-only mode when body is absent/malformed. `parseBody` would convert silent-fallback to 400. **Action**: pre-migration, add a regression test `"POST without body returns 200 with PRF-only credentials"` to pin existing behavior. Migration option: keep `req.json()` inside try/catch and add inline comment `// req.json bypass: optional-body semantics preserved; size-bounded by Node.js default streaming limit — followup if exposed`. The cap is then NOT enforced for this route; flag as a known limitation in the C8 invariant.
       - `src/app/api/mcp/register/route.ts:73` — current parse-failure path returns `{ error: "invalid_request" }` per RFC 7591 / RFC 6749 §5.2 OAuth error format. `parseBody` would change error shape to `{ error: "INVALID_JSON" }`, breaking RFC 7591 compliance for OAuth clients (Claude Code, Claude Desktop). **Action**: keep `req.json()` inside try/catch with the existing RFC-compliant error response. Add inline comment `// req.json bypass: RFC 7591 error format required`. Add a regression test `"returns invalid_request (RFC 7591) for malformed JSON body"` to pin the contract.
   - The C8 forbidden pattern, updated for Round 2 F-R2-1: `pattern: (?:req|request)\.json\(\)` outside `parse-body.ts` AND outside the 2 SPECIAL CASE routes. Add explicit allowlist comments at the 2 special-case sites so future R3 sweeps recognize the exception.
   - Existing tests for the 19 mechanically-migrated routes (21 - 2 special case): most should still pass because `parseBody`'s `req.json()` internally fires the same code path. Routes that previously caught their own `req.json()` errors return their own error shape — those try/catch blocks should be removed after migration (test files will need updates for the error response shape change in those few routes; spot-check each one).
10. **`deny` step-up**:
    - In `src/app/api/tenant/access-requests/[id]/deny/route.ts`, immediately after the
      `actor = await requireTenantPermission(...)` block, add `const stepUpError = await requireRecentCurrentAuthMethod(req); if (stepUpError) return stepUpError;` — matching `approve/route.ts:46`.

### Horizontal expansion (R3 propagation sweep)

Performed before plan-write; results:
- `grep -rn "allowTokens:\s*true" src/` → 3 hits (all 3 are in api-keys routes, all 3 fixed above).
- `grep -rn "authOrToken(req\|authOrToken(request" src/` → 4 hits:
  - `vault/delegation/check/route.ts:30` (fixed above)
  - `v1/openapi.json/route.ts:14` (NOT a vulnerability — intentional any-auth gate; add inline
    comment only)
  - `tenant/access-requests/route.ts:106` (fixed above)
  - `check-auth.ts:66` (legitimate internal use inside the helper itself)

Cryptographic version metadata (C7) horizontal sweep:
- `grep -rn "itemKeyVersion\|teamKeyVersion\|aadVersion\|keyVersion" src/lib/services/ src/app/api/`
  → two write paths handle these fields: `team-password-service.ts updateTeamPassword` (lines 359-422)
  and `app/api/passwords/[id]/route.ts` PATCH (lines 174-175). Both are fixed in C7. Personal vault
  AAD (`buildPersonalEntryAAD`) does NOT include `keyVersion`/`aadVersion` directly in the AAD bytes,
  so the threat is "wrong decryption attempt" rather than "AAD mismatch", but the symptom is identical
  (entry undecryptable). Both write paths are addressed.

JSON body cap (C8) horizontal sweep:
- `grep -rn "await req\.json\(\)" src/` → all matches are inside `parse-body.ts` after this PR.
  Existing call sites of `parseBody` need to be audited for legitimate large payloads (bulk-import,
  bulk-trash, bulk-restore, attachments) — the audit is performed in Phase 2 and documented as
  explicit `maxBytes` overrides.

No other call sites use the anti-pattern. The R3 sweep is complete pre-implementation.

## Contracts

### C1 — `checkAuth({ allowTokens: true })` without `scope` is a runtime error

- **File**: `src/lib/auth/session/check-auth.ts`
- **Signature change**: none; behavior change only
- **Invariant**: `if (allowTokens && scope == null) throw new Error(...)` — fires in all
  environments, not only `development`
- **Forbidden patterns**:
  - `pattern: console\.warn\("checkAuth: allowTokens is true but no scope is set` — reason: replaced
    by throw
  - `pattern: process\.env\.NODE_ENV === "development"` within `check-auth.ts` — reason: the
    dev-only branch is removed
- **Acceptance criteria**: `checkAuth(req, { allowTokens: true })` throws `Error` synchronously;
  `checkAuth(req, { scope: ... })` is unaffected; `checkAuth(req)` is unaffected

### C2 — `/api/api-keys` POST, GET, DELETE are session-only

- **Files**:
  - `src/app/api/api-keys/route.ts` (GET, POST)
  - `src/app/api/api-keys/[id]/route.ts` (DELETE)
  - `src/lib/proxy/cors-gate.ts` — remove `API_PATH.API_KEYS` from `EXTENSION_TOKEN_ROUTES`
    (Round 1 S-1: defense-in-depth — proxy layer should not bypass session validation for a
    route that no longer accepts Bearer tokens)
- **Signature change**: each handler replaces `checkAuth(req, { allowTokens: true })` with
  `checkAuth(req)`; remove the `if (authed.auth.type === "api_key" || ...)` rejection block (now
  unreachable); remove the `if (authed.auth.type === "session")` step-up guard in POST and call
  `requireRecentCurrentAuthMethod(req)` unconditionally
- **Invariant**: every code path through `/api/api-keys/*` verifies a browser session before
  inspecting body / params; POST additionally verifies recent re-auth; CORS / Bearer-bypass list
  in `cors-gate.ts` reflects the route's actual auth requirements
- **Forbidden patterns**:
  - `pattern: allowTokens:\s*true` in `src/app/api/api-keys/` — reason: token-based API-key
    management is the gap being closed
  - `pattern: authed\.auth\.type === "api_key"` in `src/app/api/api-keys/` — reason: dead branch
    once tokens are rejected at the gate
  - `pattern: API_PATH\.API_KEYS` in `src/lib/proxy/cors-gate.ts` `EXTENSION_TOKEN_ROUTES` array
    — reason: must be removed in C2
- **Acceptance criteria**:
  - `curl -H "Authorization: Bearer ext_..." POST /api/api-keys` → 401 at route handler;
    additionally proxy no longer routes this through the Bearer-bypass branch (verify via
    `cors-gate.ts` not listing `API_PATH.API_KEYS`)
  - `curl -H "Cookie: __Secure-authjs.session-token=..." POST /api/api-keys` → 200 if recent
    re-auth satisfied, 403 with step-up error otherwise
  - GET/DELETE behave identically except no step-up requirement

### C3 — `/api/tenant/access-requests` POST admin branch is session-only

- **File**: `src/app/api/tenant/access-requests/route.ts`
- **Signature change**: replace top-level `authOrToken(req)` with explicit branching:
  1. If `Authorization: Bearer sa_*` (detect via header inspection or a typed `authOrToken(req, scope)` call) → SA self-service path with `SA_TOKEN_SCOPE.ACCESS_REQUEST_CREATE`
  2. Otherwise → `auth()` for session
  3. Any other auth type → `unauthorized()`
- **Invariant**: `authResult.type` reaching the admin path is exactly `"session"`. The
  `actor.tenantId` derivation runs only after session is confirmed.
- **Forbidden patterns**:
  - `pattern: authResult\.type === "api_key"` in `tenant/access-requests/route.ts` — reason: API
    keys should not perform admin operations on machine-identity surfaces
  - `pattern: authResult\.type !== "session"` followed by `enforceAccessRestriction` in the same
    function — reason: admin path no longer reaches the non-session branch
- **Acceptance criteria**:
  - Session as ADMIN + valid body → 201 (existing behavior preserved)
  - `Bearer sa_*` with `ACCESS_REQUEST_CREATE` scope → 201 (SA self-service preserved)
  - `Bearer api_*` (even owned by an admin user) → 401
  - `Bearer ext_*` → 401
  - `Bearer mcp_*` → 401 (already rejected today; preserved)

### C4 — `/api/vault/delegation/check` requires `delegation:check` scope (MCP + session only)

- **Files**:
  - `src/app/api/vault/delegation/check/route.ts`
  - `src/lib/constants/auth/mcp.ts` (add `MCP_SCOPE.DELEGATION_CHECK` + `MCP_SCOPE_RISK` entry)
  - `src/app/[locale]/mcp/authorize/consent-form.tsx` (or wherever scope labels live) — add
    i18n label for `delegation:check` (Round 1 F-6)
  - `messages/en.json` and `messages/ja.json` — add the scope label translation
- **Signature change**:
  - Add `DELEGATION_CHECK: "delegation:check"` to `MCP_SCOPE` const-object only (NOT to
    `SA_TOKEN_SCOPE` — see "Out of scope" below and Round 1 F-2)
  - Update `MCP_SCOPE_RISK[DELEGATION_CHECK] = "use"` (Round 1 S-3: oracle response is an
    entry-existence side channel; `"use"` matches `CREDENTIALS_USE` risk class)
  - Replace `authOrToken(request)` with `authOrToken(request, "delegation:check")` — single
    scope string, no signature widening needed
- **Invariant**: only MCP tokens whose scope grants `delegation:check` AND sessions reach the
  lookup. SA tokens, API keys, extension tokens all 403.
- **Forbidden patterns**:
  - `pattern: authOrToken\(request\)\b` in `vault/delegation/check/` — reason: scope must be passed
  - `pattern: SA_TOKEN_SCOPE\.DELEGATION_CHECK` anywhere — reason: this PR intentionally omits
    SA support (see Out of scope)
- **Acceptance criteria**:
  - `mcp_token` with `delegation:check` scope → 200/403 (existing oracle behavior preserved)
  - `mcp_token` without scope → 403 `scope_insufficient`
  - `api_key` (cannot carry `delegation:check` scope) → 403
  - `extension_token` (cannot carry `delegation:check` scope) → 403
  - `sa_token` → 403 (intentionally unsupported; SA route extension is a follow-up PR)
  - Session → 200/403 (unchanged)

#### Out of scope (deferred to follow-up PR)

SA token support for `delegation/check` is intentionally NOT added in this PR. Reasons (per
Round 1 F-2):

1. `service_account` auth type has no `userId` field; the route's existing `hasUserId` gate
   rejects SA tokens before scope check.
2. The delegation lookup query (`where: { userId, mcpAccessToken: { mcpClient: ... } }`) is
   MCP-client-centric — there is no `serviceAccountId`-keyed delegation record.
3. No existing CLI agent flow uses SA tokens to call this endpoint (verified Round 1).

If a future use case demands SA-token delegation check, a follow-up PR adds: (a) a parallel
delegation-record schema keyed by `serviceAccountId`, (b) a route branch that uses
`serviceAccountId` instead of `userId` in the lookup, (c) `SA_TOKEN_SCOPE.DELEGATION_CHECK`,
(d) the same scope addition to `SA_TOKEN_FORBIDDEN_SCOPES` if it should not be JIT-requestable.

**Code-comment anchor (Round 2 S-10)**: add a comment in
`src/lib/constants/auth/service-account.ts` immediately above the `SA_TOKEN_SCOPE` object:
```ts
// NOTE: `delegation:check` is intentionally NOT a SA scope. The delegation lookup is
// MCP-client-centric (joins mcpAccessToken.mcpClient). SA support requires a parallel
// serviceAccountId-keyed delegation record AND a route branch using serviceAccountId
// instead of userId. Adding `DELEGATION_CHECK` here without those changes produces a
// silent 403 because the route's `hasUserId` gate rejects SA tokens.
```
This anchor makes the constraint visible at the constant definition so a future contributor
adding the scope is reminded of the structural prerequisites.

#### Consumer-flow walkthrough for C4

- Consumer 1 (path: `cli/src/agent.ts` — decrypt agent, MCP path): reads `{ authorized, sessionId, expiresAt }` and uses `authorized` to gate the decrypt operation, `sessionId` for audit correlation, `expiresAt` for client-side TTL display. All three fields exist in the locked shape (lines 111-115 of the route).
- Consumer 2 (path: session-based browser diagnostic, if any): reads same shape, browser flow.
- No consumer reads any other field; the 403 path returns `{ authorized: false, reason }` and the existing reason values (`no_session`, `entry_not_delegated`, `unauthorized`, `rate_limit`) are preserved.

### C5 — `createTeamPassword` / `updateTeamPassword` validate `tagIds` ownership

- **File**: `src/lib/services/team-password-service.ts`
- **Signature change**: none; add a guard before the `connect` / `set` operation
- **Invariant**: every tag ID written into a team password entry's `tags` relation belongs to the
  same `teamId` as the entry
- **Forbidden patterns**:
  - `pattern: tags:\s*\{\s*connect:\s*tagIds\.map` UNLESS preceded in the same function by a
    `teamTag.count` check against `teamId` — reason: this is the bypass we are closing
  - `pattern: tags:\s*\{\s*set:\s*tagIds\.map` — same reason
- **Acceptance criteria**:
  - Create/update with `tagIds` belonging to the same team → 200
  - Create/update with `tagIds` belonging to a different team in the same tenant → 404
    `NOT_FOUND` (CORRECTED from Round 1 F-1 — `API_ERROR.TAG_NOT_FOUND` does NOT exist; we reuse
    `API_ERROR.NOT_FOUND` which is 404 and aligns with REST conventions for "referenced resource
    not in this scope")
  - Create/update with `tagIds: []` or `tagIds: undefined` → 200 (no guard fires)

### C6 — `openapi.json` annotates intentional any-auth gate

- **File**: `src/app/api/v1/openapi.json/route.ts`
- **Signature change**: none
- **Invariant**: add a one-line comment above `await authOrToken(req)` stating the design intent
  ("any valid auth — non-public OpenAPI spec; not a scope-gated resource"). This is a
  documentation-only change so future R3 sweeps for `authOrToken(req)` without scope can see the
  justification and not flag it.
- **Forbidden patterns**: none
- **Acceptance criteria**: comment exists immediately above the call site; behavior unchanged

### C7 — Cryptographic version metadata cannot change without re-encryption

- **Files**:
  - `src/lib/services/team-password-service.ts` (`updateTeamPassword`)
  - `src/app/api/passwords/[id]/route.ts` (PATCH handler)
- **Signature change**: none; pre-write guard only
- **Invariant**:
  - Team: when any of `itemKeyVersion`, `teamKeyVersion`, `aadVersion` differs from the existing
    row's value, the call MUST also carry a new `encryptedBlob` (i.e. `isFullUpdate === true`)
  - Personal: when any of `keyVersion`, `aadVersion` is provided AND differs from the existing
    row's value, the call MUST also carry a new `encryptedBlob`
- **Forbidden patterns**:
  - `pattern: updateData\.itemKeyVersion =` UNLESS preceded in the same function by an
    `isFullUpdate` guard — reason: closes the metadata-only mutation that breaks AAD
  - `pattern: updateData\.aadVersion =` UNLESS preceded by the same guard in both team and
    personal update paths
  - `pattern: updateData\.keyVersion =` UNLESS preceded by the same guard in the personal path
- **Acceptance criteria**:
  - Team `updateTeamPassword({ itemKeyVersion: existing+1 })` without `encryptedBlob` → 409
    `KEY_VERSION_WITHOUT_REENCRYPT` (CORRECTED from Round 1 F-7 — `ITEM_KEY_VERSION_DOWNGRADE`
    is semantically wrong because the guard fires on any change incl. upgrades. Add new error
    code `KEY_VERSION_WITHOUT_REENCRYPT: "KEY_VERSION_WITHOUT_REENCRYPT"` to **all three maps**
    (Round 2 F-R2-2 — explicit): `API_ERROR`, `API_ERROR_STATUS` (409), and `API_ERROR_I18N`
    (`keyVersionWithoutReencrypt`). Add translations per Round 2 S-11 — use user-domain language,
    NOT internal jargon: en `"Cannot update encryption settings without re-encrypting the entry"`,
    ja `"エントリを再暗号化せずに暗号化設定を変更できません"`)
  - Team update with `{ encryptedBlob, encryptedOverview, itemKeyVersion: existing+1, ... }` → 200
  - Personal `PATCH /api/passwords/[id]` with `{ aadVersion: existing+1 }` and no `encryptedBlob` → 409 `KEY_VERSION_WITHOUT_REENCRYPT`
  - Personal update with `{ encryptedBlob, aadVersion: existing+1 }` → 200
  - No-op writes (same `aadVersion` as existing) without `encryptedBlob` → 200 (the guard only
    fires when the value actually changes — Round 1 T-10 requires a test for this case)
- **Zod schema tightening** (Round 1 S-7 / RS3 + Round 2 S-9 correction):
  - `itemKeyVersion`, `teamKeyVersion`, `keyVersion`: add `.max(TEAM_KEY_VERSION_MAX)` (10_000).
    These are rotation counters; 10_000 prevents PostgreSQL INT overflow without being practically
    restrictive.
  - `aadVersion`: KEEP existing `.max(1)` on personal schema (`src/lib/validations/entry.ts:61`)
    AND ADD `.max(1)` to team schema (`src/lib/validations/team.ts:91` currently has only `.min(1)`).
    `aadVersion` is a protocol format version, NOT a rotation counter. Only version 1 is defined
    (per `crypto-aad.ts:19 const AAD_VERSION = 1`). Bounding it tightly prevents future format
    confusion attacks. (Round 2 S-9 — Round 1 incorrectly proposed `.max(10_000)` for `aadVersion`;
    that would silently accept versions 2-9999 that the server cannot handle.)

### C8 — `parseBody` enforces `content-length` cap + 18-route migration + platform backstop

- **Files**:
  - `src/lib/http/parse-body.ts` (signature extension + guard)
  - `src/lib/validations/common.server.ts` (new constant `MAX_JSON_BODY_BYTES = 1_048_576`)
  - `src/lib/http/api-error-codes.ts` — REMAP `API_ERROR_I18N.PAYLOAD_TOO_LARGE` from
    `"fileTooLarge"` to new `"payloadTooLarge"` key (do NOT add a new error code — it exists)
  - `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json` — add `payloadTooLarge`
    translation (Japanese: `リクエストボディが大きすぎます`)
  - `next.config.ts` — add platform body cap (Round 1 S-2). App Router has no default; without
    this, chunked-TE requests omitting content-length can exhaust memory.
  - `src/lib/http/parse-body.test.ts` — existing 114-line file (Round 1 T-5 — it is NOT new);
    add 4 new test cases (over-cap, no header, under-cap, explicit override accepted)
  - The 18 routes calling `req.json()` directly (Round 1 F-3) — migrate to `parseBody`. See full
    list in "Per-finding fix" section 9.
- **Signature change**:
  - `parseBody<T>(req: NextRequest, schema: ZodSchema<T>, options?: { maxBytes?: number }): Promise<ParseResult<T>>`
- **Invariant**: every JSON body parse in the codebase goes through `parseBody`, which applies
  the content-length cap; per-route overrides use `{ maxBytes }` and are grep-able for audit
- **Forbidden patterns**:
  - `pattern: await req\.json\(\)` outside of `parse-body.ts` — reason: enforceable after the
    18-route migration in this PR completes
- **Acceptance criteria**:
  - `POST` with `content-length: 2000000` to a default-cap route → 413 `PAYLOAD_TOO_LARGE`
  - `POST` with no `content-length` header → proceeds (`next.config.ts` `serverComponentsHmrCache`
    or equivalent body-cap setting acts as backstop)
  - `POST` with `content-length: 500000` → proceeds; Zod still validates
  - `vault/rotate-key` with explicit `{ maxBytes: 16 * 1024 * 1024 }` accepts 5 MB body
  - All 18 migrated routes continue to pass their existing unit tests (parseBody's return shape
    is compatible with the prior manual `try { await req.json() }` pattern)
  - `api-errors-i18n-coverage.test.ts` still passes after `payloadTooLarge` key is added

### C9 — `POST /api/tenant/access-requests/[id]/deny` requires step-up

- **File**: `src/app/api/tenant/access-requests/[id]/deny/route.ts`
- **Signature change**: none; insert step-up check
- **Invariant**: immediately after `actor = await requireTenantPermission(...)` and before any
  business logic, the handler calls `requireRecentCurrentAuthMethod(req)` and returns early on
  error — mirroring `approve/route.ts:46`
- **Forbidden patterns**:
  - `pattern: requireTenantPermission\(.*SERVICE_ACCOUNT_MANAGE` UNLESS followed within 10 lines
    by `requireRecentCurrentAuthMethod` — reason: SA admin operations need step-up consistently
- **Acceptance criteria**:
  - Session without recent re-auth → 403 step-up required
  - Session with recent re-auth → 200 deny succeeds
  - Existing approve tests are unaffected

## Testing strategy

### Unit tests (Vitest, mocked DB) — `src/__tests__/` and route-adjacent `*.test.ts`

For each contract:

| Contract | Test file | Cases (Round 1 corrections in **bold**) |
|----------|-----------|-----------------------------------------|
| C1 | `src/lib/auth/session/check-auth.test.ts` | adds: `throws Error when allowTokens:true without scope`; **DELETE existing tests** at lines 270-310 ("enables token auth without scope when allowTokens is true", "emits console.warn..."), at lines 348-**366** (CORRECTED from 348-364 per Round 2 T-R2-4 — describe block's closing brace is line 366) ("allows token auth without access restriction check" group) — Round 1 T-1 |
| C2 | `src/app/api/api-keys/route.test.ts`, `[id]/route.test.ts`, AND `src/lib/proxy/cors-gate.test.ts` | adds: `rejects extension token on GET/POST/DELETE` (401), `POST step-up called unconditionally on session auth`; **DELETE existing tests in route.test.ts**: "returns key list for extension token auth", "calls checkAuth with allowTokens..." (GET+POST), "skips session step-up for extension-token auth" — Round 1 T-2; **DELETE 2 more in [id]/route.test.ts** (Round 2 T-R2-1): "revokes API key for extension token auth" (line 112), "calls checkAuth with allowTokens and enforces access restriction" (line 146); **UPDATE mock assertions**: all `expect(mockCheckAuth).toHaveBeenCalledWith(..., { allowTokens: true })` → `checkAuth(req)` no second arg — Round 1 X-2; **UPDATE cors-gate.test.ts truth table** (Round 2 F-R2-4): change `expected: true` to `expected: false` for `/api/api-keys` and `/api/api-keys/k1` entries at lines 33-34; update `reason` strings accordingly |
| C3 | `src/app/api/tenant/access-requests/route.test.ts` | adds: `rejects api_key from admin path`, `rejects extension_token from admin path`, **`rejects mcp_token from admin path`** (Round 1 T-12); preserves: SA self-service path, session admin path |
| C4 | `src/app/api/vault/delegation/check/route.test.ts` + `src/lib/constants/auth/mcp.test.ts` | adds: `403 scope_insufficient when mcp_token lacks delegation:check`, `403 when extension_token`, `403 when api_key`, **`403 when sa_token` (intentionally unsupported)** (revised per F-2); **`expect(MCP_SCOPE_RISK[MCP_SCOPE.DELEGATION_CHECK]).toBe('use')`** (Round 1 T-6 + Round 2 T-R2-6 — corrected; the existing `MCP_SCOPES.length` and `Object.keys(MCP_SCOPE_RISK).length` assertions self-heal because they derive from `Object.values(MCP_SCOPE)`, NO manual count update needed); **DELETE existing test** `accepts Bearer token auth (extension token)` at delegation/check `route.test.ts:95` (Round 1 T-3) |
| C5 | `src/lib/services/team-password-service.test.ts` | adds: `rejects tagIds from another team in same tenant on create`, `... on update`; preserves: same-team tagIds accepted |
| C7 | `src/lib/services/team-password-service.test.ts` and `src/app/api/passwords/[id]/route.test.ts` + `src/__tests__/api-errors-i18n-coverage.test.ts` (re-run) | adds: `rejects itemKeyVersion change without encryptedBlob` (team) → 409 `KEY_VERSION_WITHOUT_REENCRYPT`, `rejects aadVersion change without encryptedBlob` (personal), **`no-op: same aadVersion without encryptedBlob → 200`** for both team and personal paths (Round 1 T-10); preserves: full-update with version change accepted; **verify `api-errors-i18n-coverage.test.ts` passes after adding `keyVersionWithoutReencrypt` to both locale files** (Round 2 T-R2-5) |
| C8 | `src/lib/http/parse-body.test.ts` (**existing file — Round 1 T-5**) | adds to existing file: `rejects request with content-length over default cap`, `accepts when content-length header is absent`, `accepts with explicit larger maxBytes` (Round 1 T-5 #4); plus migration smoke tests for the 18 routes (most existing tests should pass unchanged) |
| C9 | `src/app/api/tenant/access-requests/[id]/deny/route.test.ts` | **UPDATE mock setup**: add `requireRecentCurrentAuthMethod` to the mocked imports (mirroring approve/route.test.ts) — Round 1 T-4; adds: `requires recent re-auth (403 without)`, `deny succeeds when step-up satisfied` |

For C2/C3/C4, mock setup MUST use the same `authOrToken` / `checkAuth` patterns existing tests use
in this repo — no new mocking style.

### Integration tests (real DB) — only if not covered by unit + E2E

C5 has an adversarial cross-team scenario that benefits from a real-DB integration test:
`src/__tests__/integration/team-password-tag-ownership.test.ts`. The test creates two teams in
one tenant and two team tags (one per team). Per Round 1 T-9 (RT4-style guard) the test MUST
include BOTH directions:

- **Positive path**: same-team `tagIds` → `count === tagIds.length` → entry created successfully
- **Negative path**: cross-team `tagIds` → `count < tagIds.length` → 404 `NOT_FOUND`

Without the positive assertion, a guard that always fires (e.g. due to an RLS bug) would
vacuously pass the negative test. This is a NEW test file.

### E2E tests (Playwright) — `e2e/`

No new E2E tests required. Per Round 1 T-11: `e2e/tests/settings-api-keys.spec.ts` is a
session-based UI flow test and does NOT exercise extension-token → API path. It catches
regressions in session-based API-key management. Extension-token rejection is covered by unit
tests only (sub-agent F-2's `extension/` audit confirmed no extension code calls these endpoints).
Phase 2 will run the full `e2e:headless` (or project equivalent) suite before commit.

### Mandatory checks before commit

Per `CLAUDE.md`:
1. `npx vitest run` — all tests pass
2. `npx next build` — production build succeeds
3. `scripts/pre-pr.sh` — pre-PR script (catches CI-only checks locally)

Per `feedback_skip_build_for_test_only.md`, build is not skipped here because production code changes.
Per `feedback_run_pre_pr_before_push.md`, pre-pr.sh runs before push.

## Considerations & constraints

### Backward compatibility

This is a security tightening. Extension Token holders attempting to manage API keys will start
receiving 401. Per `feedback_no_reflexive_migration_warnings.md`, we do NOT add a deprecation
warning or migration shim — pre-1.0 project, no external integrations documented this surface.

If an extension version was depending on this (verified Phase 2 by inspecting `extension/src/`),
we would split this into a deprecation PR + removal PR. Initial review of extension code suggests
no such dependency; Phase 2 confirms.

### Risk: removing session step-up bypass

C2's POST step-up becomes unconditional. Previously, a token-authenticated POST skipped step-up.
Since tokens cannot reach POST anymore (rejected at C2 gate), the `if session` guard becomes
trivially equivalent to "always". We remove the `if` to make the invariant readable.

### Risk: delegation/check tightening breaks CLI agent

The CLI agent (`cli/src/agent.ts`) currently issues `delegation/check` calls with the bearer token
it received via OAuth 2.1 DCR (MCP token) or via SA mint (SA token). Both token types will need
the new `delegation:check` scope in their default scope grant. Phase 2 verifies the default scope
sets in:
- `src/app/api/mcp/authorize/consent/route.ts` (MCP consent flow — scope chosen per consent)
- `src/app/api/tenant/service-accounts/[id]/tokens/route.ts` (SA token mint — scope chosen by admin)

The plan does NOT auto-grant `delegation:check` to existing tokens — that would be a silent
privilege widening. Existing MCP tokens must re-consent (or admin re-issue) to gain the scope.
This is the correct behavior; we document it in the manual test plan (`Pre-conditions`) and
release notes.

### Out of scope

- The `openapi.json` route's `isPublic` semantics — adding a comment only.
- `withBypassRls` usage in `access-requests/route.ts` — orthogonal RLS concern, not a token-scope
  issue.
- `delegation/check` rate limiter tuning — current 120/min is unchanged.
- Audit-log emission shape — unchanged for all affected endpoints.

## User operation scenarios

### Scenario 1 — extension user creating an API key (expected: blocked)

1. Pre-condition: user has installed the browser extension and has an active extension token.
2. User opens the extension popup, navigates to a hypothetical "Generate API Key" action (does
   not exist in current UI; this is the adversarial scenario).
3. Extension issues `POST /api/api-keys` with `Authorization: Bearer ext_...`.
4. Expected: 401 Unauthorized. Audit log records no entry (auth failure pre-handler).

### Scenario 2 — admin minting an access request from settings (expected: allowed)

1. Pre-condition: admin user signed in via browser, recent re-auth not required (POST is not the
   step-up endpoint here — only api-keys POST is).
2. Admin navigates to `/dashboard/tenant/service-accounts/[id]/access-requests/new`.
3. Form submission issues `POST /api/tenant/access-requests` with session cookie.
4. Expected: 201 Created.

### Scenario 3 — SA self-service access request (expected: allowed)

1. Pre-condition: SA holds an `sa_*` token with `access-request:create` scope.
2. SA runs `curl -X POST -H "Authorization: Bearer sa_..." /api/tenant/access-requests` with body.
3. Expected: 201 Created. Audit logs `actorType=SERVICE_ACCOUNT`.

### Scenario 4 — CLI agent delegation check (expected: allowed with new scope)

1. Pre-condition: user re-runs OAuth consent for their MCP client, granting `delegation:check`.
2. Agent calls `GET /api/vault/delegation/check?clientId=mcpc_X&entryId=Y` with MCP bearer.
3. Expected: 200 `{ authorized: true, sessionId, expiresAt }` or 403 `{ authorized: false, reason }`.

### Scenario 5 — CLI agent without re-consent (expected: blocked)

1. Pre-condition: user has an MCP token from before this PR (no `delegation:check` scope).
2. Agent calls the same endpoint.
3. Expected: 403 with `scope_insufficient`. Agent surfaces an actionable error directing the user
   to re-consent.

### Scenario 6 — team admin adding tag from another team (expected: blocked)

1. Pre-condition: tenant has Team A and Team B. User is admin of both.
2. User opens Team A entry creation, somehow obtains Team B's tagId (e.g., via dev tools).
3. Form submits with `tagIds: ["<team-B-tag-id>"]`.
4. Expected: 400 `TAG_NOT_FOUND`. Entry is not created.

### Scenario 7 — authorized editor tries to bump itemKeyVersion without re-encryption (expected: blocked)

1. Pre-condition: user is a writer on a team. Selects an existing entry with `itemKeyVersion=1`.
2. User issues `PUT /api/teams/<teamId>/passwords/<entryId>` with body `{ itemKeyVersion: 2 }` and no `encryptedBlob`.
3. Expected: 409 `ITEM_KEY_VERSION_DOWNGRADE`. Entry remains decryptable.

### Scenario 8 — unauthenticated request with oversized body (expected: blocked at boundary)

1. Pre-condition: none.
2. Attacker issues `POST /api/auth/passkey/options` with `content-length: 5000000`.
3. Expected: 413 `PAYLOAD_TOO_LARGE` before any body processing. Memory footprint stays bounded.

### Scenario 9 — admin denying without recent re-auth (expected: blocked)

1. Pre-condition: admin user has an active session but last re-auth was >5 min ago (project's
   step-up threshold).
2. Admin navigates to the deny button for a pending access request.
3. Expected: 403 `STEP_UP_REQUIRED`. UI prompts the admin to re-authenticate; deny succeeds after
   re-auth.

## Implementation order (mandatory — Round 1 S-6)

Phase 2 implements contracts in this order to avoid mid-implementation 500s:

1. **C2** (api-keys → session-only) — remove all `{ allowTokens: true }` uses first
2. **C3** (access-requests admin path → session-only)
3. **C4** (delegation/check scope)
4. **C5** (TeamTag teamId validation)
5. **C7** (version metadata + Zod max bounds)
6. **C8** (parseBody cap + 18-route migration + next.config.ts cap + i18n remap)
7. **C9** (deny step-up)
8. **C1** (checkAuth runtime throw) — **MUST come last**. If C1 lands before C2/C3, the 3
   api-keys routes immediately throw 500 in production.
9. **C6** (openapi.json comment) — documentation only, order does not matter

A single PR is fine; order within the PR is enforced by commit sequence.

## Go/No-Go Gate

| ID | Subject                                                                  | Status |
|----|--------------------------------------------------------------------------|--------|
| C1 | `checkAuth({ allowTokens: true })` without scope throws                  | locked |
| C2 | `/api/api-keys` POST/GET/DELETE → session only + step-up + cors-gate     | locked |
| C3 | `/api/tenant/access-requests` admin path → session only                  | locked |
| C4 | `/api/vault/delegation/check` → MCP `delegation:check` scope + session   | locked |
| C5 | TeamPassword tagIds validated against `teamId` (reuse `NOT_FOUND`)       | locked |
| C6 | `openapi.json` intentional any-auth comment                              | locked |
| C7 | Cryptographic version metadata cannot change without re-encryption       | locked |
| C8 | `parseBody` cap (1 MB) + 18-route migration + platform body cap          | locked |
| C9 | `POST /api/tenant/access-requests/[id]/deny` requires step-up            | locked |

All contracts locked (Round 1 corrections applied). Plan ready for Phase 1 Round 2 sub-agent
review or termination check.
