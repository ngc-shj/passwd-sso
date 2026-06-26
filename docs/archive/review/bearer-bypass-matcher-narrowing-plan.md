# Plan: Bearer-bypass matcher narrowing (method + exact path)

## Project context

- **Type**: web app + service (Next.js 16 App Router, multi-tenant E2E password manager). Proxy (`src/proxy.ts` + `src/lib/proxy/*`) is the single ingress.
- **Test infrastructure**: unit (vitest) + integration (real-DB) + E2E (playwright) + CI/CD. Proxy behavior is unit-tested in `src/__tests__/proxy.test.ts` and `src/lib/proxy/*` tests.
- **Verification environment constraints**:
  - Proxy matcher logic: `verifiable-local` (pure-function unit tests on `isBearerBypassRoute`).
  - Extension passkey-replace DELETE flow end-to-end: `blocked-deferred` — requires a real browser extension + WebAuthn authenticator. The handler-level token auth change is unit-tested; the extension wiring already exists (`swFetch` DELETE) and is exercised manually. (Cost-justification: a full WebAuthn-in-extension E2E rig is out of proportion; the handler change is unit-covered and the extension already issues the call.)

## Objective

Remediate OWASP review M2/M3: the Bearer-bypass matcher (`isBearerBypassRoute` in `src/lib/proxy/cors-gate.ts`) is path-prefix-based and over-broad — `/api/passwords/**` and `/api/teams/<id>/passwords/**` make every mutating child (bulk-*, empty-trash, attachments, etc.) Bearer-REACHABLE at the proxy. Today those children are `auth()`-only so a cookieless Bearer 401s at the handler, but the matcher is a latent risk: migrating any child to a write scope silently makes it Bearer-WRITABLE (the `S1 LOCKED CONSTRAINT` comment warns about exactly this).

**Goal**: replace the prefix matchers with a **method + exact-path allowlist** so only the routes that legitimately need Bearer access are reachable, structurally closing the latent risk.

**Coupled essential fix (user-directed, no deferral)**: the browser extension's passkey-replace cleanup issues `DELETE /api/passwords/[id]` via Bearer (`extension/src/background/passkey-provider.ts:449`), but the handler is `checkAuth(req)` (session-only) so it 401s and the extension swallows it (`.catch(()=>{})`) — a pre-existing broken flow. Migrate the DELETE handler to `checkAuth(req, {scope: PASSWORDS_WRITE})` for **soft-delete only**, keeping permanent-delete (`?permanent=true`) closed to tokens (step-up cannot be satisfied by a Bearer token).

## Requirements

### Functional
- R1: `isBearerBypassRoute` becomes method-aware: `isBearerBypassRoute(pathname, method)`. The caller (`src/lib/proxy/api-route.ts:24`) passes `request.method`.
- R2: The matcher allows ONLY these (method, exact-path) pairs (derived from the verified needs-Bearer map):
  - `GET /api/passwords`, `POST /api/passwords`
  - `GET /api/passwords/<id>`, `PUT /api/passwords/<id>`, `DELETE /api/passwords/<id>`
  - `GET /api/teams`
  - `GET /api/teams/<id>/member-key`
  - `GET /api/teams/<id>/passwords`, `GET /api/teams/<id>/passwords/<id>`
  - `GET /api/vault/status`, `GET /api/vault/unlock/data`
  - `GET /api/vault/delegation/check`
  - `POST /api/vault/ssh/sign-authorize`
  - `DELETE /api/extension/token`, `POST /api/extension/token/refresh`, `POST /api/extension/key/reset` (unchanged exact matches)
  - `GET /api/tenant/access-requests` is session-only — **excluded**; `POST /api/tenant/access-requests` (SA token JIT) **kept**.
- R3: Every mutating child currently reachable via prefix (bulk-*, empty-trash, restore, favorite, attachments, history, generate; team POST/PUT/DELETE; `/api/teams` POST; `/api/vault/delegation` POST/GET/DELETE; access-requests `[id]/**` and GET) is NO LONGER Bearer-reachable. Behavior for these is unchanged for real clients: they were session-only and already 401 a cookieless Bearer; now the 401 comes from the proxy instead of the handler.
- R4: `DELETE /api/passwords/<id>` handler accepts a `passwords:write` token for **soft-delete**. With `?permanent=true` AND a token caller → 403 (tokens cannot satisfy step-up; return an explicit FORBIDDEN, not a confusing 401). Session callers retain full behavior incl. permanent-delete with step-up.

### Non-functional
- R5: No change to which legitimate client flows work (extension/iOS/CLI). The only behavioral change is the now-working extension passkey-replace soft-delete (R4) and the proxy returning 401 earlier for never-legitimate Bearer paths.
- R6: Keep `isBearerBypassRoute` a pure function; method+path only, no I/O.

## Technical approach

### Matcher: method + exact-path table

Replace `EXTENSION_TOKEN_ROUTES` prefix logic + `isBearerBypassTeamPath` with a single declarative table of `{ method, test(pathname) }` entries, where `test` is an exact regex (anchored) or exact-string compare. Path params (`<id>`) use `[^/]+` anchored segments. The three already-exact extension-token routes stay exact.

Structure (illustrative, not final code):
```
type BearerRule = { methods: ReadonlySet<string>; match: (p: string) => boolean };
const BEARER_RULES: readonly BearerRule[] = [ ... ];
export function isBearerBypassRoute(pathname: string, method: string): boolean {
  return BEARER_RULES.some(r => r.methods.has(method) && r.match(pathname));
}
```
- Exact paths (`/api/passwords`, `/api/teams`, vault leaves, extension-token leaves): string equality.
- Param paths (`/api/passwords/<id>`, `/api/teams/<id>/passwords`, `/api/teams/<id>/passwords/<id>`, `/api/teams/<id>/member-key`, `/api/vault/delegation/check`): anchored regex with `[^/]+` for the id segment(s) and NO trailing `(/.*)?` (that trailing wildcard is the bug).

### Caller wiring

`src/lib/proxy/api-route.ts`: the bypass branch (line 83) uses `isBearerBypassRoute(pathname, request.method)`. OPTIONS preflight (line 29-30) must still allow extension CORS for any path with ANY Bearer-allowed method, but an OPTIONS request's method is `"OPTIONS"` (not in any allowlist), so a method-aware call would return false and break preflight. Therefore api-route.ts computes TWO values: `isBearerBypassPath(pathname)` (path-only, any-method) wired into the preflight `isBearerRoute` field (line 30), and `isBearerBypassRoute(pathname, request.method)` (method-aware) for the bypass branch (line 83). Do NOT collapse the current single `isBearerRoute` assignment into one method-aware call — line 30 must read the path-only value (F3).

**Caller blast-radius (signature change):** `isBearerBypassRoute(pathname)` → `(pathname, method)` breaks callers that pass one arg. Enumerated callers to update:
- `src/lib/proxy/api-route.ts` — the two-value wiring above.
- `src/lib/proxy/cors-gate.test.ts` — the truth table at `:67` calls `isBearerBypassRoute(tc.path)` single-arg across ~35 rows; the whole table must be restructured to `{path, method, expected}` (F5/T1).
- `src/lib/proxy/route-policy.ts` does NOT call it (comments only, lines 24/96/155-161) — but those comments claim cors-gate "mirrors" route-policy's prefix matcher, which becomes false after this change; update them to state cors-gate is now method+exact and intentionally no longer mirrors the prefix classifier (F7).

### Stale comment replacement

The `S1 LOCKED CONSTRAINT` block (cors-gate.ts:41-46) warns that the prefix makes mutating children Bearer-reachable. After narrowing this is obsolete; replace it with: "The matcher is the structural Bearer gate — a route is Bearer-reachable ONLY if its (method, exact-path) appears in `BEARER_RULES`. A handler-level `checkAuth(req, {scope})` with a write scope is now SAFE without a matching table entry: the proxy fails closed (cookieless Bearer → session-required → 401) before the handler runs. To actually enable Bearer write for a new route, add its (method, exact-path) pair here." (S5)

### DELETE handler token support (R4)

`src/app/api/passwords/[id]/route.ts` handleDELETE:
- Change `checkAuth(req)` → `checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE })`.
- After resolving `permanent`: if `permanent === true` AND `authResult.auth.type !== "session"` → return a 403 BEFORE the step-up call. **Use `!== "session"`, NOT `=== "token"`** — the auth discriminants are `session | token | api_key | mcp_token`; `=== "token"` would miss api_key/mcp_token callers (F1/S1/RS2), leaving the invariant unenforced for them and giving a confusing 401 from step-up. `!== "session"` covers all non-session token types and mirrors the v1 precedent (`v1/passwords/[id]/route.ts:307-312`).
- `forbidden()` takes NO arguments (`api-response.ts:81`). To carry a clear message use `errorResponseWithMessage(API_ERROR.FORBIDDEN, "Permanent deletion requires step-up authentication and is not available via token.")` (F2). Defense-in-depth: even if this guard regressed, `requireRecentCurrentAuthMethod` reads the session cookie and a Bearer-only request has none → 401, so permanent-delete stays closed regardless (S1).
- Soft-delete path: unchanged logic, now reachable by token.
- Update the handler's `// Session-only` comment (line 273) to reflect token soft-delete support.

## Contracts

### C1 — method-aware `isBearerBypassRoute` + path-only `isBearerBypassPath` — locked
- **File**: `src/lib/proxy/cors-gate.ts`.
- **Signatures**:
  - `isBearerBypassRoute(pathname: string, method: string): boolean`
  - `isBearerBypassPath(pathname: string): boolean` (any method allowed for that path — preflight use)
- **Invariant** (app-enforced): `isBearerBypassRoute(p, m)` returns true IFF `(m, p)` is in the R2 allowlist. No prefix/`startsWith` wildcard remains for password paths.
- **Forbidden patterns**:
  - `pattern: passwords\(\\/\.\*\)\?` — reason: the trailing-wildcard team-passwords regex is the M2 bug; must be gone
  - `pattern: startsWith\(route \+ "/"\)` in cors-gate.ts — reason: prefix matching for password routes is the M3 bug
- **Acceptance**: unit tests enumerate every R2 (method,path) → true; every R3 mutating child (all methods) → false; wrong method on an allowed path (e.g. `POST /api/teams`, `DELETE /api/teams/<id>/passwords/<id>`, `PUT /api/passwords/<id>/attachments`) → false.
- **Consumer-flow walkthrough**:
  - Consumer `handleApiAuth` (path: `src/lib/proxy/api-route.ts`) reads `isBearerBypassRoute(pathname, request.method)` at the bypass branch (line 83) and `isBearerBypassPath(pathname)` for the OPTIONS preflight `isBearerRoute` (line 24/30). It uses the boolean to decide whether a cookieless Bearer request short-circuits to `NextResponse.next()` (bypass) vs falls through to the session-required 401 path. Both signatures are satisfiable from (pathname, method) alone — no other field needed.

### C2 — caller passes method; preflight unchanged — locked
- **File**: `src/lib/proxy/api-route.ts`.
- **Change**: line 24 → `isBearerBypassRoute(pathname, request.method)` for the bypass branch; preflight (`handleApiPreflight`) uses `isBearerBypassPath(pathname)` so OPTIONS still allows extension CORS for any path with a Bearer-allowed method.
- **Invariant**: OPTIONS preflight CORS behavior for Bearer paths is unchanged (extension can still preflight GET/PUT/DELETE on `/api/passwords/<id>`).
- **Acceptance**: proxy test — cookieless Bearer to an R2 (method,path) → `NextResponse.next()` (bypass); cookieless Bearer to an R3 child or wrong-method → 401 (session-required path). OPTIONS to `/api/passwords/<id>` → preflight allows extension origin.

### C3 — DELETE /api/passwords/[id] token soft-delete; token+permanent → 403 — locked
- **File**: `src/app/api/passwords/[id]/route.ts` (handleDELETE).
- **Change**: `checkAuth(req, {scope: PASSWORDS_WRITE})`; `permanent && auth.type !== "session"` → `errorResponseWithMessage(API_ERROR.FORBIDDEN, ...)` before step-up; session behavior unchanged.
- **Invariant** (app-enforced): a `passwords:write` token (any of token/api_key/mcp_token) can soft-delete (trash) its own entry; NO non-session caller can permanent-delete (explicit 403 + step-up backstop); cross-user delete → 404 (existing oracle collapse preserved).
- **Forbidden patterns**:
  - `pattern: const authResult = await checkAuth\(req\);` in `[id]/route.ts` handleDELETE — reason: must pass the write scope now
  - `pattern: permanent && authResult.auth.type === "token"` — reason: must be `!== "session"` to cover api_key/mcp_token (F1)
- **Acceptance**: unit — token soft-delete → 200 + entry trashed (assert `update` with `deletedAt`, `delete` NOT called); token + `?permanent=true` → 403 (no delete/update/audit); **api_key + permanent → 403 AND mcp_token + permanent → 403** (pin the `!== "session"` discriminant, T4); cross-user token → 404; session + permanent + fresh step-up → 200 hard-delete (unchanged); **session + permanent + stale step-up → step-up response (proves step-up still session-reachable)**; **ordering: token + permanent with step-up mocked to return 401 → response is 403 (token guard short-circuits before step-up, T5)**; **scope-wiring: assert `checkAuth` called with `{scope: PASSWORDS_WRITE}` (the mock is arg-agnostic, so without this the scope change is vacuously untested, T4.5)**.
- **Consumer-flow walkthrough**: Consumer = browser extension passkey-replace cleanup (path: `extension/src/background/passkey-provider.ts:449`). It issues `DELETE /api/passwords/<replaceEntryId>` with a Bearer token (via `swFetch`, no `?permanent`), expecting the stale passkey entry to be trashed. It reads only the HTTP status (currently `.catch(()=>{})`-swallowed). After C3 the call succeeds (200, soft-delete). No response body field is consumed. iOS/CLI do not call this DELETE with permanent via token.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | method-aware matcher + path-only preflight helper | locked |
| C2 | caller wiring (method passed; preflight via path-only helper) | locked |
| C3 | DELETE token soft-delete; token+permanent → 403 | locked |

## Testing strategy

- **C1** (`src/lib/proxy/cors-gate.test.ts`): restructure the truth table from `{path, expected}` to `{path, method, expected}` (T1). Several EXISTING rows must **flip** (not just gain a method field) — these are false-green traps asserting the old over-broad behavior:
  - `/api/teams/<id>/passwords/bulk-import` → **false** (was true, the M2 bug)
  - `/api/vault/delegation` (bare, non-check) → **false** (was true)
  - `/api/vault/unlock/data/extra` (child wildcard) → **false** (was true)
  - `/api/tenant/access-requests` → method-split: `POST`→true, `GET`→false
  - Add wrong-method negatives: `POST /api/teams`→false, `DELETE /api/teams/<id>/passwords/<id>`→false, `PUT /api/passwords/<id>/attachments`→false, `POST /api/vault/unlock/data`→false.
  - All R2 allow-rows enumerated per-method (incl. `member-key` exact, `delegation/check` exact, `ssh/sign-authorize` POST, the three extension-token leaves).
  - Add a separate `describe("isBearerBypassPath")` block (path-only, any-method): true for `/api/passwords/<id>`, `/api/teams/<id>/passwords`, `/api/extension/token`; false for a never-Bearer path like `/api/teams/<id>/webhooks` and `/api/passwordsx` (T2).
- **C2** (`src/__tests__/proxy.test.ts`): `createApiRequest` defaults to GET and cannot express a method — extend it (add a method param) or build raw `NextRequest`s (T3). Add: cookieless Bearer `POST /api/passwords/bulk-import`→401; `DELETE /api/teams/<id>/passwords/<id>`→401; `POST /api/teams`→401 (wrong method on allowed path); `DELETE /api/passwords/<id>`→bypass (the new R4 flow through the proxy); OPTIONS preflight on a CHILD path (`/api/passwords/<id>`)→allows extension origin (covers `isBearerBypassPath`). Also add a `classifyRoute` assertion that a representative R3 child (`/api/passwords/bulk-import`) maps to `API_SESSION_REQUIRED`, so a future route-policy regression can't silently re-open the gate (S5).
- **C3** (`src/app/api/passwords/[id]/route.test.ts`): mirror the GET block's token-auth mock shape (`{type:"token", scopes:["passwords:write"]}`, route.test.ts:139) and the v1 permanent-403 oracle (`v1/passwords/[id]/route.test.ts:563-577`, asserts no DB/audit). Cases: token soft-delete→200; token+permanent→403; api_key+permanent→403; mcp_token+permanent→403; cross-user token→404; session+permanent+fresh→200; session+permanent+stale→step-up; token+permanent with step-up mocked non-null→403 (ordering); scope-wiring assertion `checkAuth` called with `{scope: PASSWORDS_WRITE}`. Note the existing session DELETE tests survive (mock is arg-agnostic) — that's why the scope-wiring assertion is required to avoid a vacuous pass.
- Mandatory: `npx vitest run` + `npx next build` + `bash scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract
- **SC1**: This PR does NOT add Bearer/token support to any mutating child beyond the DELETE soft-delete fix (R4). bulk-*, empty-trash, restore, favorite, attachments, history, generate, team POST/PUT/DELETE remain session-only AND now proxy-unreachable via Bearer. Future token support for any of them MUST add the (method, exact-path) pair to the C1 table in the same change (the table is now the single gate). Owner: future feature PR if needed.
- **SC2**: `/api/vault/delegation` POST/GET/DELETE lose Bearer-reachability (only `/check` is kept). Verified: the CLI agent only calls `/check` via Bearer; the POST/GET/DELETE management endpoints are session-only (web app). If a future CLI flow needs them, add to the C1 table.
- **SC3**: The extension's `DELETE` was the only client-side Bearer call to a previously-session-only password route. No other extension/iOS/CLI Bearer call targets an R3 child (verified in the needs-Bearer map). If this is wrong, the proxy will start 401ing a previously-working flow — covered by C2 tests + manual extension check.

### Known risks
- Over-narrowing risk: if the needs-Bearer map missed a legitimate Bearer client flow, that flow breaks (proxy 401). Mitigation: the map was built by grepping extension/ios/cli for Bearer calls; C2 tests assert each kept route; manual extension smoke for the DELETE flow.
- C3 widens write-surface: `DELETE /api/passwords/<id>` (soft-delete) is now token-writable. This is intentional and consistent with POST/PUT already being `passwords:write`. Permanent-delete stays session+step-up only.

## User operation scenarios

1. Extension passkey-replace: registers a new passkey replacing an old entry → extension `DELETE /api/passwords/<oldId>` (Bearer) → entry trashed (was: 401 swallowed, stale entry lingered).
2. Attacker with a leaked `passwords:write` token tries `POST /api/passwords/bulk-import` cross-origin Bearer → proxy 401 (was: reached handler, which 401'd as auth()-only; now structurally blocked at proxy, and can never become writable by a future scope migration without an explicit table entry).
3. CLI agent `GET /api/vault/delegation/check` (Bearer) → works (kept). CLI has no need for `POST /api/vault/delegation` → that stays session-only.
4. Token caller `DELETE /api/passwords/<id>?permanent=true` → 403 (permanent needs step-up; tokens can't). Session caller same with fresh reauth → hard-delete.
5. Web app (session cookie) on any of these routes → unchanged (never used the Bearer bypass).
