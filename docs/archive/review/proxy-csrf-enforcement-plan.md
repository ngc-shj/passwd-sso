# Plan: Proxy-Level CSRF Enforcement + Proxy Modularization

## Project context

- **Type**: web app (Next.js 16 App Router + TypeScript 5.9 + Prisma 7 + PostgreSQL 16 + Auth.js v5)
- **Test infrastructure**: unit (vitest) + integration (real Postgres) + E2E (Playwright) + CI/CD (GitHub Actions)

## Background

A prior triangulate review (`csrf-admin-token-cache-review.md`) surfaced
three pre-existing findings + an R3 baseline gap (9 session-cookie-bearing
mutating routes lacking `assertOrigin`). An earlier plan attempt
(`centralize-route-guards-plan-superseded.md`) tried to solve this with
per-route HOF wrappers + CI scanner — 4 review rounds revealed this was
over-engineered: it treated the symptom (each route opt-in to CSRF defense)
rather than the cause (CSRF should not be opt-in at all).

This plan's premise: **CSRF defense is fundamentally an ingress-layer
concern.** Move it to the single ingress point (`proxy.ts`). Routes
become consumers, not enforcers, of this baseline defense.

## Objective

1. **Eliminate the R3 baseline gap structurally** by enforcing
   `assertOrigin` in `proxy.ts` for all session-cookie-bearing mutating
   API requests. This makes the gap impossible to recreate by future
   route additions.
2. **Keep `src/proxy.ts` under the 500-line soft cap** by extracting
   responsibility-based modules under `src/lib/proxy/`. This is the means,
   not the goal — the modularization is required because the new
   enforcement code would otherwise grow `proxy.ts`.
3. **Establish a clear responsibility boundary** between proxy and route
   handlers, documented in CLAUDE.md, so future contributors know what
   belongs where.

Pre-existing findings closed by this plan:

- **pre1** — audit-emit `assertOrigin` missing → resolved by proxy enforcement
- **R3 baseline** — 9 session-mutating routes lack `assertOrigin` → resolved structurally

## Requirements

### Functional

- Proxy MUST `assertOrigin` for any **API request** matching ALL of:
  - method ∈ {POST, PUT, DELETE, PATCH}
  - session cookie (`__Secure-authjs.session-token` or `authjs.session-token`) is present
- The check is **request-attribute-based, not path-classification-based**:
  it fires regardless of whether the route is in the proxy's session-
  required list, the Bearer-bypass list, or falls through to the default
  branch. This ensures `/api/internal/*`, `/api/folders/*`, and any future
  cookie-auth route is covered without per-path enumeration.
- Bearer-only callers (extension, MCP, SCIM, SA, API key) MUST bypass this
  check naturally because they don't carry session cookies (the gate's
  `hasSessionCookie` precondition fails).
- The proxy's own internal fetch to `/api/internal/audit-emit` (passkey
  enforcement audit emission) MUST set `Origin: <self-origin>` explicitly.
  Node fetch does not auto-set Origin; the proxy declares same-origin so
  the new CSRF gate accepts the self-call.
- Routes that currently call `assertOrigin(req)` inline MUST have this call
  removed (Single Source of Truth — proxy is now authoritative).
- Routes with **stricter** CSRF-related checks beyond baseline (e.g.,
  `vault/admin-reset` requires `APP_URL` to be explicitly set, no Host
  fallback) MUST keep those stricter checks at the route level.
- `src/proxy.ts` MUST become a thin orchestrator (target ≤ 100 lines).
  Heavy logic moves to `src/lib/proxy/` modules.

### Non-functional

- Zero behavior change for existing callers. Same status codes (401/403/etc.)
  for the same conditions. Order-of-check changes are acceptable only if
  (a) they don't introduce new failure modes and (b) they're documented.
- Zero test regression: `npx vitest run` + `npm run test:integration` +
  `npx playwright test` must pass.
- Zero build/lint regression: `npx next build`, `npm run lint`,
  `npm run check:bypass-rls`, `npm run check:team-auth-rls`,
  `npm run check:env-docs` must pass.
- Each commit is independently revertable.

## Technical approach

### Responsibility boundary (the key conceptual change)

| Layer | Responsibility | Does NOT |
|-------|----------------|----------|
| `proxy.ts` (orchestrator) + `src/lib/proxy/*` | session validation, baseline CSRF for **cookie-bearing** mutating requests (Origin), CORS preflight, rate limit (pre-auth), access restriction (IP), security headers, route classification | authorization (scope/role/ownership), business logic, Origin checks for cookie-LESS routes |
| `route.ts` | authorization, input validation (Zod), business logic, route-specific stricter checks (going beyond baseline), **Origin enforcement for pre-auth / no-cookie mutating routes** (proxy gate doesn't apply) | baseline CSRF for cookie-bearing requests (proxy handles), session cookie parsing |

**Single Source of Truth**: proxy is authoritative for baseline CSRF.
Routes do not duplicate it.

### Target file structure

```
/proxy.ts                              94行  (untouched — Next.js middleware entry + CSP construction)
/src/proxy.ts                          ~80行 (orchestrator only)
/src/lib/proxy/security-headers.ts     new   (applySecurityHeaders extraction)
/src/lib/proxy/auth-gate.ts            new   (getSessionInfo, sessionCache, extractSessionToken, setSessionCache)
/src/lib/proxy/cors-gate.ts            new   (Bearer-bypass detection, preflight wiring)
/src/lib/proxy/route-policy.ts         new   (classifyRoute pure function — pathname → discriminated union)
/src/lib/proxy/csrf-gate.ts            new   (assertSessionCsrf — the root cause fix)
```

### `csrf-gate.ts` design

The CSRF gate is **request-attribute-gated**, not path-classification-gated.
This is the core insight: CSRF defense applies to any request whose
attributes match the attack surface (browser sends session cookie + state-
mutating method), regardless of which route classification the path falls
into. This makes it impossible for new "internal" routes (or any future
non-classified mutating route with cookie auth) to silently lack CSRF
protection.

```ts
// src/lib/proxy/csrf-gate.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { assertOrigin } from "@/lib/auth/session/csrf";

const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Returns true when the request matches the CSRF attack surface:
 * session-cookie-bearing mutating API request.
 *
 * Bearer-only callers (extension, MCP, SCIM, SA, API key) don't carry
 * session cookies, so they pass `hasSessionCookie === false` and skip
 * the check naturally.
 */
export function shouldEnforceCsrf(
  request: NextRequest,
  hasSessionCookie: boolean,
): boolean {
  return hasSessionCookie && MUTATING_METHODS.has(request.method);
}

/**
 * Run the Origin assertion. Returns null for pass-through, or a 403
 * NextResponse if Origin mismatch.
 *
 * Routes that need stricter origin checks (e.g., requiring APP_URL to be
 * explicitly set, no Host-header fallback) keep those route-level
 * additions on top of this baseline.
 */
export function assertSessionCsrf(request: NextRequest): NextResponse | null {
  return assertOrigin(request);
}
```

### Orchestrator (final state of `src/proxy.ts`)

After all extractions, `src/proxy.ts` becomes a thin orchestrator:

```ts
import { classifyRoute } from "./lib/proxy/route-policy";
import { getSessionInfo, hasSessionCookie } from "./lib/proxy/auth-gate";
import { handlePreflight, applyCorsHeaders } from "./lib/proxy/cors-gate";
import { applySecurityHeaders } from "./lib/proxy/security-headers";
import { shouldEnforceCsrf, assertSessionCsrf } from "./lib/proxy/csrf-gate";
import { checkAccessRestrictionWithAudit } from "./lib/auth/policy/access-restriction";

export async function handleApiAuth(request) {
  const policy = classifyRoute(request.nextUrl.pathname);

  // All early-return / non-CSRF paths must precede the CSRF gate.
  if (policy.kind === "preflight")       return handlePreflight(request, policy);
  if (policy.kind === "public-share")    return NextResponse.next();
  if (policy.kind === "public-receiver") return NextResponse.next();
  if (policy.kind === "api-v1")          return NextResponse.next();

  // CSRF gate (request-attribute-based, path-independent).
  // Fires for ANY remaining API request matching: session cookie + mutating method.
  // This covers /api/internal/*, /api/folders/*, etc. that aren't in the
  // session-required classification but still use cookie auth at the
  // route handler level.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookiePresent = hasSessionCookie(cookieHeader);
  if (shouldEnforceCsrf(request, cookiePresent)) {
    const csrfError = assertSessionCsrf(request);
    if (csrfError) return applyCorsHeaders(request, csrfError);
  }

  if (policy.kind === "api-bearer-bypass") return handleBearerRoute(request, policy);
  if (policy.kind === "api-session-required") {
    const session = await getSessionInfo(request);
    if (!session.valid) return unauthorized();
    if (!await checkAccessRestriction(session, request)) return forbidden();
    return next();
  }
  // api-default: fall through (CSRF already enforced above if applicable)
  return next();
}
```

**Critical ordering note (resolves F3, S4)**: ALL non-CSRF policy
early-returns (`preflight`, `public-share`, `public-receiver`, `api-v1`)
MUST precede the CSRF gate. Each represents a path that's outside the
cookie-CSRF threat model:
- `preflight`: OPTIONS, no body, no auth
- `public-share`: unauthenticated public share-link viewers
- `public-receiver`: public POST receivers (csp-report) accepting reports
  from any origin including sandboxed contexts
- `api-v1`: public REST API authenticated by API key (Bearer); a stale
  session cookie alongside a valid API key MUST NOT cause a 403.

**Key property**: the CSRF gate runs BEFORE policy-specific dispatch. It
fires whenever the request carries a session cookie and uses a mutating
method, regardless of how the path is classified. Routes that aren't
in any classification (api-default fall-through) — like
`/api/internal/audit-emit` and `/api/folders/*` — get protection
automatically.

Target line count: ≤ 100 lines.

## Implementation steps

All work lands on a single branch `refactor/proxy-csrf-enforcement`.

**C1. Extract `security-headers.ts`** (smallest extraction first, lowest risk).
   - Move `applySecurityHeaders` from `src/proxy.ts:441-480` to
     `src/lib/proxy/security-headers.ts`.
   - Re-export from `src/proxy.ts` as a deprecation shim (`_applySecurityHeaders`)
     to keep `src/__tests__/proxy.test.ts` passing without changes.
   - **Verification**: `npx vitest run` (full suite), `npx next build`.
   - **Commit**: `refactor(proxy): extract security-headers module`

**C2. Extract `auth-gate.ts`** (the largest extraction).
   - Move `getSessionInfo`, `sessionCache`, `setSessionCache`,
     `extractSessionToken`, `SESSION_CACHE_TTL_MS`, `SessionInfo` type
     from `src/proxy.ts` to `src/lib/proxy/auth-gate.ts`.
   - `src/proxy.ts` re-exports `_sessionCache`, `_setSessionCache`,
     `_extractSessionToken` as deprecation shims so the existing
     `proxy.test.ts` test bodies remain unchanged.
   - **Verification**: `npx vitest run`, `npx next build`.
   - **Commit**: `refactor(proxy): extract auth-gate module`

**C3. Extract `cors-gate.ts` + `route-policy.ts`**.
   - `cors-gate.ts`: move `extensionTokenRoutes`, `isBearerBypassRoute`,
     and the preflight wiring block from `src/proxy.ts`. The existing
     `src/lib/http/cors.ts` (with `handlePreflight`, `applyCorsHeaders`)
     is the lower-level utility; `cors-gate.ts` is the proxy-specific
     orchestration around it.
   - `route-policy.ts`: replace the long `pathname.startsWith(...)` chain
     in `handleApiAuth` with a `classifyRoute(pathname): RoutePolicy` pure
     function returning a discriminated union:
     ```ts
     type RoutePolicy =
       | { kind: "preflight" }
       | { kind: "public-share" }              // /api/share-links/*/content, /verify-access
       | { kind: "public-receiver" }           // /api/csp-report — public POST receiver
       | { kind: "api-v1" }                    // /api/v1/* — API-key authenticated
       | { kind: "api-bearer-bypass"; route: string }
       | { kind: "api-session-required" }
       | { kind: "api-default" }
       | { kind: "page" };
     ```
     **Naming MUST be consistent**: the orchestrator's `policy.kind ===`
     comparisons MUST use the exact strings from this union. Spelling
     mismatches cause TypeScript discriminated-union narrowing to fail
     silently (the branch is statically unreachable). The plan body has
     been normalized to use `api-session-required` (not `api-session`).
     **Naming consistency note (resolves S2)**: the orchestrator code in
     this plan and the `RoutePolicy` union MUST use `api-bearer-bypass`
     consistently (not `api-bearer`). All references in the plan body
     have been normalized.

     **`csp-report` classification (resolves F2)**: `/api/csp-report`
     accepts CSP violation reports from browsers, including from
     sandboxed contexts where Origin may be `null`. It is a public
     receiver — no auth, no CSRF. Classified as `public-receiver` so the
     CSRF gate does NOT fire (since CSRF gate runs after preflight /
     public-* early-returns). Without this classification, a logged-in
     user's browser submitting a CSP report with the session cookie
     attached would 403 incorrectly.

     **`api-v1/openapi.json` exception note (resolves S5)**: most v1
     handlers use `validateV1Auth` (Bearer-only). The single exception
     `/api/v1/openapi.json` uses `authOrToken` which accepts session
     cookies when `OPENAPI_PUBLIC=false`. This is GET-only, returns the
     OpenAPI spec (no tenant-sensitive data), and is method-gated out
     of the CSRF check anyway. The classifier still maps it to `api-v1`
     for consistency; the auth difference is contained at the route
     handler level. No security impact — documented for completeness.
   - Add `src/lib/proxy/route-policy.test.ts` with exhaustive case coverage
     (every API_PATH constant tested).
   - **Verification**: `npx vitest run`, `npx next build`.
   - **Commit**: `refactor(proxy): extract cors-gate + route-policy modules`

**C4. Add `csrf-gate.ts` + wire into orchestrator + fix internal fetch** — **the root cause fix**.

   1. **Create `src/lib/proxy/csrf-gate.ts`** with `shouldEnforceCsrf` and
      `assertSessionCsrf` (see design above). The gate is request-attribute-
      based, NOT path-classification-based.

   2. **Wire CSRF check into orchestrator at API request entry**:
      - Insert the check in `handleApiAuth` AFTER all non-CSRF
        early-returns (`preflight`, `public-share`, `public-receiver`,
        `api-v1`) and BEFORE policy-specific dispatch (`api-bearer-bypass`,
        `api-session-required`, `api-default`). See orchestrator code
        above for the exact ordering — implementer MUST mirror it
        verbatim (resolves F4: prose-code consistency).
      - This ensures `/api/internal/audit-emit`, `/api/folders/*`, and
        any future cookie-auth route — whether classified as
        api-session-required or falling through to api-default — gets
        CSRF protection.
      - **Closes pre1 structurally**: audit-emit's lack of `assertOrigin`
        is now resolved without enumerating it in any path list.

   3. **Fix proxy's internal fetch to declare same-origin** (resolves the
      self-collision risk):
      - `src/proxy.ts:153` makes a fire-and-forget HTTP fetch to
        `/api/internal/audit-emit` for passkey enforcement audit emission.
        It currently sends `cookie` but not `Origin`. Node fetch (undici)
        does NOT auto-set Origin. After step 2, this internal fetch would
        be 403'd by the new CSRF gate.
      - Add explicit `Origin` header derived from `request.url`:
        ```ts
        const selfOrigin = new URL(request.url).origin;
        void fetch(new URL(`${basePath}${API_PATH.INTERNAL_AUDIT_EMIT}`, request.url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": selfOrigin,
            cookie: request.headers.get("cookie") ?? "",
          },
          body: JSON.stringify({...}),
        }).catch(() => {});
        ```
      - This declares "same-origin" to the CSRF gate, which then matches
        against `getAppOrigin()` or Host-header fallback — both should
        agree with `selfOrigin` in any consistent deployment.

   4. **Helper export from `auth-gate.ts`**: expose
      `hasSessionCookie(cookieHeader: string): boolean` (existing
      `extractSessionToken` returning non-empty is the implementation).
      This is what the orchestrator uses to gate CSRF.

   5. **`src/lib/proxy/csrf-gate.test.ts` cases**:
      - `shouldEnforceCsrf`:
        - GET + cookie present → false
        - POST + cookie absent → false
        - POST + cookie present → true
        - PUT/DELETE/PATCH + cookie present → true (parametrized)
        - HEAD/OPTIONS + cookie present → false
      - `assertSessionCsrf`:
        - matching Origin → null
        - mismatched Origin → 403
        - missing Origin → 403
        - APP_URL unset, Host present, derived origin matches → null (fallback path)
        - APP_URL unset, Host missing → 403

   6. **`src/__tests__/proxy.test.ts` integration cases (NEW)**:
      - session-cookie POST to `/api/passwords` with mismatched Origin → 403
      - session-cookie GET to `/api/passwords` with mismatched Origin → pass-through
      - **session-cookie POST to `/api/internal/audit-emit` with mismatched Origin → 403** (validates pre1 structural close)
      - session-cookie POST to `/api/internal/audit-emit` with matching Origin → pass-through
      - extension Bearer POST to `/api/passwords` with chrome-extension:// Origin → pass-through (no session cookie, gate skips)
      - **Bearer + session cookie + mismatched Origin → 403 (resolves S3)**:
        a request carrying both extension Bearer AND a stale session
        cookie with a chrome-extension:// Origin → 403 from CSRF gate
        (cookie precondition is true, gate fires before Bearer-bypass).
        This documents and locks the order-of-check change for the rare
        "developer signed in to web app while testing extension" scenario.
      - maintenance POST to `/api/maintenance/purge-history` with `ADMIN_API_TOKEN` and no session cookie → pass-through
      - **CSP report POST to `/api/csp-report` with session cookie + null/cross-origin Origin → pass-through (resolves F2)**:
        public-receiver classification short-circuits before CSRF gate.
      - **api-v1 POST to `/api/v1/passwords` with API key Bearer + stale
        session cookie + cross-origin Origin → pass-through (resolves S4)**:
        api-v1 classification short-circuits before CSRF gate. Documents
        the developer scenario "logged in to web app while testing API
        key REST call" — must not produce false-positive 403.
      - Internal-fetch shape: simulate the proxy's self-fetch (POST to
        audit-emit with explicit `Origin: <self-origin>` matching
        `getAppOrigin()`) → pass-through (validates step 3).
      - **Counter-test for internal fetch (resolves T3)**: simulate the
        proxy's self-fetch WITHOUT explicit `Origin` (Node fetch default)
        → 403. Locks in the requirement that future refactors of step 3
        cannot drop the Origin header without breaking this test.

   - **Verification**: `npx vitest run`, `npx next build`,
     `npm run test:integration`.
   - **Commit**: `feat(proxy): enforce baseline CSRF on cookie-bearing mutating API requests`

**C5. Remove inline `assertOrigin` from cookie-bearing routes** (Single Source of Truth — proxy gate is authoritative for cookie-CSRF).

   **Refined scope (resolves T4)**: the proxy CSRF gate has `hasSessionCookie`
   as a precondition. Routes that legitimately receive requests **without
   session cookies** (pre-auth flows, bootstrap exchanges) are NOT covered
   by the proxy gate, so their inline `assertOrigin` is NOT redundant — it
   serves a different threat model (Origin validation for pre-auth /
   anonymous mutating requests). These routes KEEP their inline check.

   **Remove inline `assertOrigin` from 21 cookie-bearing routes** (verified by reading each route's auth pattern: all 21 call `await auth()` immediately after `assertOrigin`):
   - `vault/{change-passphrase,unlock,rotate-key,admin-reset,reset}/route.ts`
   - `vault/recovery-key/{generate,recover}/route.ts`
   - `vault/delegation/route.ts`, `vault/delegation/[id]/route.ts`
   - `tenant/breakglass/route.ts`, `tenant/breakglass/[id]/route.ts`
   - `tenant/audit-delivery-targets/route.ts`, `tenant/audit-delivery-targets/[id]/route.ts`
   - `tenant/members/[userId]/reset-vault/route.ts`
   - `tenant/members/[userId]/reset-vault/[resetId]/revoke/route.ts`
   - `tenant/webhooks/route.ts`
   - `teams/[teamId]/rotate-key/route.ts`, `teams/[teamId]/webhooks/route.ts`
   - `watchtower/alert/route.ts`
   - `mcp/authorize/consent/route.ts`
   - **`extension/bridge-code/route.ts`** — session-required POST that
     generates a one-time bridge code for the extension. Comment at line
     38 confirms: "CSRF defense-in-depth — bridge-code is an Auth.js
     session POST endpoint". The CONSUMPTION endpoint
     (`/api/extension/token/exchange`) is a different route that does
     NOT call `assertOrigin` today and is out of this PR's scope.

   **KEEP inline `assertOrigin` in 3 pre-auth / cookieless routes** (Origin
   defense at route layer for requests outside the proxy gate's threat model
   — confirmed by reading each route: NONE call `await auth()`):
   - `auth/passkey/options/route.ts` — comment at line 19: "Unauthenticated
     endpoint — generates discoverable credential options for passkey sign-in"
   - `auth/passkey/options/email/route.ts` — comment at line 56:
     "Unauthenticated — generates authentication options with allowCredentials"
   - `auth/passkey/verify/route.ts` — comment at line 27: "Unauthenticated
     endpoint — verifies a passkey authentication response and creates a
     database session directly (bypassing Auth.js Credentials)". Creates
     the session cookie; inbound request has none. WebAuthn protocol-level
     origin binding (`expectedOrigin` in `verifyAuthenticationResponse`)
     provides primary defense; the inline `assertOrigin` is the early-
     reject defense-in-depth before the WebAuthn library is invoked.

   **Special case — `vault/admin-reset/route.ts`**: keep the
   post-`assertOrigin` `if (!getAppOrigin()) return 500` check (line 38-46).
   This is a STRICTER check beyond baseline (no Host fallback) and remains
   at the route level. The `assertOrigin(req)` call IS removed (admin-reset
   has session cookie, covered by proxy gate).

   **Test file migration (resolves Testing R7)**: route test files that
   contain ACTIVE behavioral assertions mocking `assertOrigin` to return
   403 will fail after C5 because the inline call no longer exists.
   Migration: DELETE those test cases (the behavior is now covered by
   `proxy.test.ts` C4 step 6).
   - Test files for the **21 REMOVED routes** that need a CSRF-403 case
     deletion (verified by grep `assertOrigin|origin check|CSRF` filtered
     by `403|forbidden` in their `*.test.ts`):
     - `vault/unlock/route.test.ts:84` — "returns 403 when Origin header is invalid"
     - `vault/rotate-key/route.test.ts:144` — same
     - `vault/delegation/[id]/route.test.ts:100` — "returns CSRF error when origin check fails"
     - `extension/bridge-code/route.test.ts:120` — "returns 403 when origin check fails"
     - `tenant/webhooks/route.test.ts:322` — "CSRF: assertOrigin blocks request..."
     - `tenant/breakglass/route.test.ts:272` — "returns 403 when CSRF assertOrigin fails"
     - `tenant/breakglass/[id]/route.test.ts:119` — same
     - `tenant/audit-delivery-targets/route.test.ts:191` — "blocks request when CSRF fails"
     - `tenant/audit-delivery-targets/[id]/route.test.ts:116` — same
     - `mcp/authorize/consent/route.test.ts:139,152` — "returns 403 when Origin header is missing/bad"
     - Implementer MUST run `grep -rn 'assertOrigin\|origin check\|CSRF' src/app/api/**/route.test.ts | grep -iE '403|forbidden'` to confirm completeness; remaining hits in test files for KEPT routes (passkey/* below) must NOT be deleted.
   - The **3 KEPT routes' test files** (passkey/options, options/email,
     verify) keep their existing CSRF-403 assertions unchanged.
   - **Note for `vault/admin-reset/route.test.ts:87`** ("returns 500 when
     APP_URL and AUTH_URL are both missing"): this tests the stricter
     check that's preserved at the route — keep as-is.

   **Mock cleanup (cosmetic)**: route test files that retain
   `vi.mock("@/lib/auth/session/csrf", ...)` for the now-removed inline
   call have an unused mock. Vitest tolerates unused mocks; the cleanup
   can land in this same commit (delete the unused `vi.mock` block) for
   files where no test references the csrf module.

   - **Verification**: `npx vitest run`, `npx next build`,
     `npm run test:integration`. Manual smoke test: POST to
     `/api/vault/unlock` with `Origin: https://evil.com` → 403 (now from proxy).
     POST to `/api/auth/passkey/options` with `Origin: https://evil.com` →
     403 (still from route — no cookie, proxy gate skipped).
   - **Commit**: `refactor(api): remove redundant assertOrigin from 21 cookie-bearing routes (proxy is SSoT); keep on 3 pre-auth routes`

**C6. Document the responsibility boundary in CLAUDE.md**.
   - Add a new subsection under "Architecture" titled "Proxy / Route
     Responsibility Boundary".
   - Document the layer table from this plan's "Technical approach" section.
   - Document the 5-module layout under `src/lib/proxy/` with one-line
     descriptions.
   - Document the SSoT principle and the stricter-check exception
     (`vault/admin-reset` as the canonical example).
   - **Commit**: `docs(claude): document proxy/route responsibility boundary`

## Testing strategy

### Unit tests (vitest)

Per new module in `src/lib/proxy/*.test.ts`:

- `csrf-gate.test.ts`: see C4 above.
- `route-policy.test.ts`: exhaustive case coverage for `classifyRoute` —
  every `API_PATH.*` constant produces the expected `RoutePolicy`.
- `auth-gate.test.ts`: existing `proxy.test.ts` cases for `getSessionInfo`,
  `setSessionCache`, `extractSessionToken` move here. Add a TTL-expiry
  test using `vi.useFakeTimers` + `vi.spyOn(globalThis, 'fetch')`.
- `cors-gate.test.ts`: Bearer-bypass detection and preflight wiring cases.
- `security-headers.test.ts`: header value assertions.

### Integration tests

- `npm run test:integration` for end-to-end DB-backed scenarios. Should
  continue to pass without modification — proxy behavior changes only
  affect 401/403 responses, not DB operations.

### Regression / smoke tests

- `src/__tests__/proxy.test.ts`: existing 700+ line file shrinks as cases
  move to module-specific files. Remaining cases test the orchestrator
  wiring (e.g., that the right gate is called for each route policy).
- **New `proxy.test.ts` cases for C4 — see C4 step 6 for the authoritative
  list (11 cases)**. Summary: session-cookie POST mismatch → 403,
  session-cookie GET mismatch → pass-through, extension Bearer pass,
  maintenance pass, audit-emit mismatch / match (pre1 closure),
  Bearer+cookie 403 (R1 case 2), csp-report pass (F2), api-v1 pass (S4),
  internal-fetch with-Origin pass / without-Origin 403 (T3). C4 step 6
  is the single source of truth for these cases — this section is a
  cross-reference summary only (resolves T7).

### Manual smoke test

After C5 lands, exercise these flows in the dev environment:

1. Browser POST to `/api/vault/unlock` with valid session + matching Origin → 200.
2. Curl POST to `/api/vault/unlock` with valid session cookie + `Origin: https://evil.com` → 403 (now from proxy).
3. Browser GET to `/api/passwords` with valid session + any Origin → 200 (mutating-only gate).
4. Extension POST to `/api/passwords` with valid extension Bearer + `chrome-extension://abc...` Origin → 201 (Bearer-bypass).
5. `scripts/purge-history.sh` with valid `ADMIN_API_TOKEN` → unchanged behavior (no session cookie, CSRF gate not invoked).

## Considerations & constraints

### Risks

- **R1 — Behavior changes in error code ordering**:
  1. **Unauth + bad-origin → 401 (was 403)**: Today, some routes (e.g.,
     `vault/admin-reset`) check `assertOrigin` BEFORE `auth()`, so an
     unauthenticated cross-origin request returns 403. After this plan,
     the proxy CSRF gate fires only when `hasSessionCookie` is true; a
     cookie-less cross-origin request reaches the route handler which
     then 401s. Tests asserting "unauth + bad-origin → 403" must be
     updated to "unauth → 401" or removed (the tests enumerated in C5
     — 10 files, 11 it-blocks).
  2. **Bearer (extension) + session cookie + bad-origin → 403**: a
     rare scenario (developer signed in to web app while testing
     extension) where a request carries both extension Bearer AND a
     stale session cookie with `chrome-extension://` Origin. The CSRF
     gate fires (cookie present), returns 403 before Bearer-bypass
     dispatch. The proper resolution is to clear cookies before testing
     extension flows.
  3. **api-v1 (API key) + session cookie + bad-origin → pass-through**:
     api-v1 is short-circuited BEFORE the CSRF gate (per F3 / S4 fix).
     Even with a stale session cookie, an API key REST call from a
     cross-origin context proceeds normally. This is the intended
     behavior — api-v1 is path-isolated from cookie-based auth.
  - Mitigation: changes are intentional and consistent. Tests documented
    in C5 (case 1) and C4 step 6 (cases 2-3).

- **R2 — Test mock cleanup**: removing inline `assertOrigin` from 21
  REMOVE-list routes leaves their `vi.mock("@/lib/auth/session/csrf", ...)`
  mock declarations unused. This is harmless (vitest tolerates unused mocks)
  but creates code-cleanup work that's worth doing during C5 to avoid
  accumulating dead test code. The 3 KEEP routes (passkey/options,
  options/email, verify) MUST retain their mocks — `assertOrigin` still
  runs at those routes.
  - Mitigation: remove the unused mocks in the same C5 commit, scoped to
    the REMOVE list only.

- **R3 — `proxy.ts` test exports are load-bearing**: existing
  `src/__tests__/proxy.test.ts` imports `_sessionCache`, `_setSessionCache`,
  `_extractSessionToken`, `_applySecurityHeaders` from `src/proxy.ts`.
  After extraction, these symbols live in their respective modules.
  - Mitigation: re-export from `src/proxy.ts` as deprecation shims (C1, C2)
    so test imports continue to work. As the test file is reorganized to
    use module-specific tests, the shims become unused and can be removed
    in a follow-up. Keeping them through this PR avoids a large test
    refactor in the same commit.

- **R4 — `vault/admin-reset` strict check preservation**: the
  `getAppOrigin()` must-be-set check (lines 38-46) is a STRICTER variant
  of the baseline. C5 must preserve this check verbatim while removing
  only the inline `assertOrigin(req)` call.
  - Mitigation: explicit instruction in C5 plus regression test for
    "admin-reset POST with `APP_URL` unset → 500".

- **R5 — Route-policy classification correctness**: the long
  `pathname.startsWith(...)` chain in current `handleApiAuth` is intricate
  (Bearer-bypass exact-match for some routes, prefix for others, public
  share-link patterns, etc.). The pure-function rewrite in C3 must
  preserve all classifications exactly.
  - Mitigation: exhaustive `route-policy.test.ts` covering every API_PATH.
    Plus the existing `proxy.test.ts` integration cases serve as a
    regression net. Note: CSRF correctness does NOT depend on this
    classification (CSRF gate is request-attribute-based) — even if a
    classification bug regresses dispatch, CSRF protection holds.

- **R6 — Internal fetch Origin propagation**: proxy's self-fetch to
  `/api/internal/audit-emit` requires explicit `Origin` header. If the
  developer adds a future internal fetch without setting Origin, it
  would 403. This is unlikely (rare pattern) but worth a comment in
  proxy.ts at the existing fetch site explaining why Origin is set.
  - Mitigation: code comment + the C4 step 6 test case "Internal-fetch
    shape" documents the pattern. Consider a small helper
    `fetchInternal(req, url, init)` if more such calls appear later
    (out of scope for this PR — only one such call exists today).

### Out of scope (tracked separately as "Plan B")

The following findings from `csrf-admin-token-cache-review.md` are NOT
addressed by this plan. Each will land as an independent small PR:

- **F2** — `rotate-master-key` weaker `operatorId` check (uses
  `user.findUnique` instead of `requireMaintenanceOperator`).
- **F1 / S3** — `purge-audit-logs` reuses `AUDIT_ACTION.HISTORY_PURGE`
  instead of a distinct `AUDIT_LOG_PURGE` action.
- **F3** — `dryRun` calls in purge routes don't emit audit log entries.
- **F4** — `passkeyAuditEmitted` map FIFO eviction.
- **S1** — `audit-emit` `metadata` field has no Zod bound.
- **S2** — CSP `form-action` localhost allowance in production.
- **pre2** — 30s session-revocation cache bypass window (Redis redesign).
- **pre3** — `operatorId` body field vs. token-bound claim (signed-token redesign).
- **T1-T4** — test infrastructure cleanups.

### Genuinely deferred (harder problems)

- `pre2` — session revocation 30s window — requires Redis-backed cache with
  active invalidation and multi-worker coordination.
- `pre3` — operatorId binding — requires per-operator signed token (JWT or
  similar) with operational migration of `ADMIN_API_TOKEN` infrastructure.

## Implementation Checklist

Files to be created (5):
- `src/lib/proxy/security-headers.ts` (+ test)
- `src/lib/proxy/auth-gate.ts` (+ test)
- `src/lib/proxy/cors-gate.ts` (+ test)
- `src/lib/proxy/route-policy.ts` (+ test)
- `src/lib/proxy/csrf-gate.ts` (+ test)

Files to be modified (24):
- `src/proxy.ts` (orchestrator simplification + add Origin to internal fetch)
- `src/__tests__/proxy.test.ts` (preserve via shims; add C4 step 6 cases)
- 21 route files (remove inline `assertOrigin` — see C5 enumeration)
- `CLAUDE.md` (responsibility boundary section)

Reused utilities (must not reimplement):
- `src/lib/auth/session/csrf.ts:assertOrigin` — Origin comparison
- `src/lib/http/cors.ts:handlePreflight, applyCorsHeaders` — CORS handling
- `src/lib/auth/policy/access-restriction.ts:checkAccessRestrictionWithAudit` — IP restriction
- `src/lib/security/security-headers.ts:PERMISSIONS_POLICY` — header constants
- `src/lib/url-helpers.ts:getAppOrigin, isHttps` — URL utils
- `src/lib/tenant-context.ts:resolveUserTenantId` — tenant resolution
- `src/i18n/locale-utils.ts:getLocaleFromPathname, stripLocalePrefix` — i18n
- `src/lib/constants/{API_PATH, MS_PER_DAY, MS_PER_MINUTE, AUDIT_ACTION}` — constants
- `src/lib/validations/common.server.ts:SESSION_CACHE_MAX` — cache size constant

## User operation scenarios

### Scenario 1: Browser session-authenticated mutation (preservation)

- **Setup**: signed-in user with unlocked vault.
- **Action**: `POST /api/passwords` (create entry) from the dashboard UI.
- **Expected (before & after)**: 200 with new entry; same audit log entry.
- **Why this works post-change**: Proxy validates session, validates
  Origin (matches `APP_URL`), passes through to route. Same outcome,
  different enforcement layer.

### Scenario 2: Cross-origin CSRF attempt on internal endpoint (pre1 closure)

- **Setup**: signed-in user, attacker page at `https://evil.com`.
- **Action**: attacker page issues `fetch(targetApp + "/api/internal/audit-emit", { method: "POST", credentials: "include", ... })`.
- **Expected (before)**: SameSite=lax + CSP `connect-src 'self'` block this
  in modern browsers, but defense-in-depth was missing for `audit-emit`
  (no inline `assertOrigin`, and proxy's session-required block doesn't
  cover `/api/internal/*`) — pre1 finding.
- **Expected (after)**: Proxy's CSRF gate (request-attribute-based:
  cookie + POST) fires regardless of path classification. Returns 403
  from `assertSessionCsrf`. **pre1 is structurally closed**: the gate
  fires for `/api/internal/audit-emit` even though it's not in the
  session-required path list.

### Scenario 3: Extension Bearer-token call (preservation)

- **Setup**: chrome-extension with valid extension Bearer token.
- **Action**: `POST /api/passwords` from extension content script with
  `chrome-extension://abc...` Origin.
- **Expected (before & after)**: 201. Bearer-bypass branch in proxy
  returns before the session check, so `assertSessionCsrf` is never
  invoked. The `chrome-extension://` Origin is irrelevant.

### Scenario 4: Maintenance API via shell script (preservation)

- **Setup**: operator with `ADMIN_API_TOKEN`.
- **Action**: `scripts/purge-history.sh`.
- **Expected (before & after)**: 200 with `purged: N`. No session cookie
  is sent; `assertSessionCsrf` is never invoked.

### Scenario 5: vault/admin-reset stricter check (preservation)

- **Setup**: production deployment with `APP_URL` unset (misconfigured).
- **Action**: `POST /api/vault/admin-reset` with valid session and
  matching Origin (Host-header derived).
- **Expected (before)**: 500 — the stricter `if (!getAppOrigin()) return
  500` check fires.
- **Expected (after)**: 500 — same check is preserved at the route level
  (C5 explicitly retains this guard). Proxy's baseline `assertSessionCsrf`
  passes (Host-header fallback succeeds), then route's stricter check
  fires.

### Scenario 6: Order-change effect (R1 risk)

- **Setup**: unauthenticated (no session cookie) cross-origin request.
- **Action**: `POST /api/vault/unlock` with `Origin: https://evil.com`.
- **Expected (before)**: 403 — current `vault/unlock` checks
  `assertOrigin` before `auth()`.
- **Expected (after)**: 401 — proxy checks session first, returns 401
  without reaching CSRF gate. This is intentional ("auth before origin"
  avoids leaking origin policy to unauthenticated probes).
- **Affected tests**: any test asserting "unauth + bad-origin → 403"
  must update to "unauth → 401". Identified during C5 implementation.
