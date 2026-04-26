# Plan: Centralize Route Guards & Modularize Proxy (SUPERSEDED)

> **SUPERSEDED 2026-04-26 by [`proxy-csrf-enforcement-plan.md`](proxy-csrf-enforcement-plan.md).**
>
> This plan was abandoned during Phase 1 review (after 4 rounds) because it
> over-engineered the actual root cause. The HOF + per-route migration + CI
> scanner approach treated the symptom ("each route should call assertOrigin")
> rather than the cause ("CSRF defense is opt-in per route"). The replacement
> plan moves CSRF enforcement to the proxy layer (single ingress point),
> making it impossible to forget by construction. This file is retained as
> a historical record of the design exploration.

## Project context

- **Type**: web app (Next.js 16 App Router + TypeScript 5.9 + Prisma 7 + PostgreSQL 16 + Auth.js v5)
- **Test infrastructure**: unit (vitest) + integration (real Postgres via `npm run test:integration`) + E2E (Playwright) + CI/CD (GitHub Actions, release-please)

## Objective

Eliminate the structural cause of inconsistent CSRF / auth / rate-limit
enforcement across API route handlers (R3 baseline finding from prior triangulate
review) by:

1. **Centralizing per-route security enforcement into composable HOF wrappers**
   under `src/lib/http/guards/`.
2. **Modularizing `src/proxy.ts`** into role-specific modules (`auth-gate`,
   `cors-gate`, `route-policy`, `security-headers`) so the proxy becomes an
   orchestrator rather than a 500-line file mixing five concerns.
3. **Adding CI enforcement** (`scripts/check-route-guards.ts`) that fails when a
   mutating route handler is not wrapped in an approved guard chain.

Pre-existing findings closed by this plan as a side effect:

- **pre1** — audit-emit `assertOrigin` missing → resolved by `withOriginAssertion`
- **F2** — rotate-master-key uses weaker operatorId check → resolved by migration
  to `withMaintenanceOperator`
- **S1** — audit-emit metadata field has no bound → resolved by Zod schema added
  alongside the migration
- **R3 baseline** — 9 session-only mutating routes lack `assertOrigin` → resolved
  structurally by HOF migration + CI gate

## Requirements

### Functional

- All `POST` / `PUT` / `DELETE` / `PATCH` handlers under `src/app/api/` MUST be
  wrapped in approved guard HOFs (or appear in an explicit allowlist with
  documented justification).
- HOFs MUST compose: outermost `withRequestLog`, then auth (`withSession` /
  `withCheckAuth` / `withMaintenanceOperator` / `withApiKey` / `withMcpToken` /
  `withSaToken` / `withScimToken`), then `withOriginAssertion` (only when
  composed with `withSession` — see composition invariant), then
  `withRateLimit`, finally the handler.
- HOFs MUST preserve current behavior — no API contract change for any route.
- `proxy.ts` MUST continue to enforce edge-level guards in the same order; only
  the source-file organization changes (no behavior change at the edge).
- CI MUST fail when a new mutating handler is not wrapped, with an error
  message indicating which HOF to add.

### Non-functional

- Zero test regression (`npx vitest run` + `npm run test:integration` +
  `npx playwright test` must pass).
- Zero build / lint regression (`npx next build`, `npm run lint`,
  `npm run check:bypass-rls`, `npm run check:team-auth-rls`,
  `npm run check:env-docs` must pass).
- Migration is reversible — each step lands as a separate commit so any step
  can be reverted independently.
- Bundle-size regression must be ≤ 0.5% on the route-handler bundle (HOFs are
  thin wrappers; no new heavy dependencies).

## Technical approach

### Existing patterns to extend

The repo already uses the `with*` HOF pattern via
[`src/lib/http/with-request-log.ts`](src/lib/http/with-request-log.ts), applied
as `export const POST = withRequestLog(handlePOST)` in maintenance routes. We
extend this pattern; we do not introduce a new convention.

### HOF design

Location: `src/lib/http/guards/`.

```ts
// src/lib/http/guards/types.ts
import type { NextRequest, NextResponse } from "next/server";

export type GuardContext = Record<string, unknown>;

export type GuardHandler<C extends GuardContext = GuardContext> = (
  req: NextRequest,
  ctx: C,
) => Promise<NextResponse>;

export type Guard<CIn extends GuardContext, COut extends GuardContext> = (
  next: GuardHandler<COut>,
) => GuardHandler<CIn>;
```

Each HOF augments the context with its proven invariant:

| HOF | Adds to ctx | On failure | Auth class |
|-----|-------------|------------|------------|
| `withSession` | `auth: SessionAuth` | 401 | session-only |
| `withCheckAuth({ scope?, allowTokens? })` | `auth: SessionOrTokenAuth` | 401 | session OR extension token (1:1 maps to existing `checkAuth(req, options)`) |
| `withMaintenanceOperator` | `operator: MaintenanceOperator` ({ tenantId, role }) | 401 (token) / 400 (operatorId) | shared admin token |
| `withApiKey`, `withMcpToken`, `withSaToken`, `withScimToken` | `auth: TokenAuth` | 401 | token-only |
| `withOriginAssertion` | `originVerified: true` | 403 | (session-only — must NOT be composed with `withCheckAuth` or token HOFs) |
| `withRateLimit(rl, keyFn)` | (no addition) | 429 | (any) |
| `withZodBody(schema)` | `body: z.infer<typeof schema>` | 400 | (any) |

**Auth class disambiguation** (resolves S1/F1):
- `withSession` is for routes whose current code calls `auth()` directly or `checkAuth(req)` with no options — session-only.
- `withCheckAuth({ scope: ... })` or `withCheckAuth({ allowTokens: true })` is for routes whose current code calls `checkAuth(req, { scope })` or `checkAuth(req, { allowTokens })` — these accept extension Bearer tokens IN ADDITION TO sessions, and the proxy lists them in `extensionTokenRoutes`.
- The CI config (`route-guards-config.json`) maps each route's path to the correct HOF chain per auth class so a developer cannot accidentally substitute `withSession` for a Bearer-aware route.

**`withOriginAssertion` composition invariant** (resolves S5/F8 from Round 2):

`withOriginAssertion` MUST NOT be composed with `withCheckAuth` on the same route. Rationale: `assertOrigin` is a CSRF defense whose threat model assumes the attacker uses the victim's session cookie. Bearer-token callers (extension, MCP, SCIM, SA, API key) do NOT carry session cookies and are immune to cookie-CSRF. Browser extensions specifically present `chrome-extension://<id>` as their Origin, which never matches the application's origin and would always be rejected by `assertOrigin` — locking out legitimate Bearer callers.

Per-auth-class composition rules:

| Auth class | Outer-to-inner chain | Notes |
|------------|----------------------|-------|
| Session-only (`withSession`) | `withRequestLog → withSession → withOriginAssertion → withRateLimit → withZodBody → handler` | Origin assertion required (cookie-CSRF defense) |
| Session-OR-Bearer (`withCheckAuth`) | `withRequestLog → withCheckAuth → withRateLimit → withZodBody → handler` | NO `withOriginAssertion` — Bearer callers carry non-matching origins legitimately |
| Maintenance (`withMaintenanceOperator`) | `withRequestLog → withMaintenanceOperator → withRateLimit → withZodBody → handler` | Bearer-only, no Origin check |
| Token-only (`withApiKey`/`withMcpToken`/`withSaToken`/`withScimToken`) | `withRequestLog → withTokenAuth → withRateLimit → withZodBody → handler` | NO `withOriginAssertion` |

The HOF design table's "Auth class" column for `withOriginAssertion` is therefore "(session-only)" — NOT "(any)". The CI config (`route-guards-config.json`) MUST encode this exclusivity: any route mapped to `withCheckAuth`/`withMaintenanceOperator`/token HOFs MUST be rejected if it also lists `withOriginAssertion`.

**Ctx shape compatibility note (resolves RT1 risk)**: The existing `checkAuth` return shape is `{ ok: true, auth: { type, userId } }` — `tenantId` is NOT in the auth object today. `withSession` MUST NOT introduce `tenantId` as a required field on `SessionAuth`; it remains an optional field resolved separately if needed. This preserves existing test fixtures.

**`withCheckAuth({ allowTokens: false })` design intent (resolves S9)**:
The plan does not introduce any production usage of `withCheckAuth({ allowTokens: false })`. This combination is semantically equivalent to `withSession`. Going forward, session-only routes MUST use `withSession`, NOT `withCheckAuth({ allowTokens: false })`. The CI config does not need to special-case this combination; the route-guards-config.json should map session-only routes exclusively to `withSession`. If a developer attempts `withCheckAuth({ allowTokens: false })` for a session-only route, the CI config-route-glob mapping rejects it because the glob requires `withSession`.

**Unauthenticated routes with origin assertion (Adjacent finding)**:
A small number of public-facing endpoints (e.g., `auth/passkey/options/route.ts`)
are unauthenticated but DO require origin assertion (CSRF defense for the
authentication request itself). For these routes, `withOriginAssertion` is
composed standalone — without any auth HOF preceding it. The composition is
valid: `withRequestLog(withOriginAssertion(withRateLimit(...)(withZodBody(schema)(handler))))`.
The route-guards-config.json maps these specific routes to a `requiredHOFs`
list of `[withOriginAssertion]` (no auth HOF required) and a corresponding
allowlist entry is NOT needed.

**`vault/admin-reset` strict APP_URL guard preservation (resolves S11)**:
`vault/admin-reset/route.ts:38-46` carries an extra-strict guard after
`assertOrigin`: if `getAppOrigin()` is unset, it returns 500 with an
explicit comment stating "admin vault reset must never run without a
configured origin." This is a deliberate stricter posture vs. plain
`assertOrigin` (which falls back to Host-header derivation). Migration
to `withOriginAssertion` would silently drop this guard.

Resolution: keep the strict APP_URL check INSIDE the handler body after
the HOF chain. The HOF chain becomes
`withRequestLog(withSession(withOriginAssertion(withRateLimit(...)(handler))))`,
and the handler's first action remains the explicit
`if (!getAppOrigin()) return 500` check. C4's migration of
`vault/admin-reset/route.ts` MUST preserve this guard verbatim — the
implementer should remove only the `assertOrigin(req)` call (now handled
by the HOF) and keep the subsequent `getAppOrigin()` check unchanged.

**Order change for routes that currently call `assertOrigin` BEFORE `auth()` (Adjacent finding)**:
Some C4 routes (e.g., `vault/admin-reset/route.ts:35-48`) call `assertOrigin`
first then `auth()`. Today, an unauthenticated cross-origin request gets 403
(origin checked first). After migration to the canonical chain
`withRequestLog → withSession → withOriginAssertion`, an unauthenticated
cross-origin request gets 401 (auth checked first; origin never reached).
This is the intended order per "auth before origin" rationale (avoids leaking
origin policy to unauthenticated probes). Tests for affected routes must be
reviewed: any existing test asserting "unauth + bad origin → 403" must be
updated to "unauth → 401". List of routes requiring this review: see C4 list
above; the order-change-affected ones are routes that currently call
`assertOrigin` before `auth()` (this is the project default — most C4 routes).

Composition order (outermost → innermost):

```ts
export const POST = withRequestLog(
  withSession(
    withOriginAssertion(
      withRateLimit(rl, (req, ctx) => `rl:audit_emit:${ctx.auth.userId}`)(
        withZodBody(bodySchema)(handlePOST),
      ),
    ),
  ),
);
```

Order rationale:
- `withRequestLog` outermost so 401/403/429 responses are logged.
- Auth before origin: an unauthenticated request gets 401 not 403 (avoids
  leaking origin policy to unauthenticated probes).
- Origin before rate limit: rate-limit key uses `ctx.auth.userId`; rejecting
  cross-origin requests before incrementing the counter prevents an attacker
  from exhausting a victim's quota.
- Rate limit before body parse: avoids parsing payloads from rate-limited
  callers.

### proxy.ts modularization

Target layout:

```
src/proxy.ts                          (orchestrator only, ≤100 lines)
src/lib/proxy/auth-gate.ts            (getSessionInfo, sessionCache, extractSessionToken)
src/lib/proxy/cors-gate.ts            (bearer-bypass route detection, preflight wiring)
src/lib/proxy/route-policy.ts         (pathname classification → guard requirements)
src/lib/proxy/security-headers.ts     (header construction; extends src/lib/security/security-headers.ts)
```

The orchestrator (`src/proxy.ts`) flow:

```ts
export async function proxy(request, options) {
  const policy = classifyRoute(request.nextUrl.pathname);
  if (policy.kind === "preflight")     return handlePreflight(request, policy);
  if (policy.kind === "public-share")  return applySecurityHeaders(NextResponse.next(), options);
  if (policy.kind === "api-bearer")    return handleBearerRoute(request, policy);
  if (policy.kind === "api-session")   return handleSessionRoute(request, options, policy);
  if (policy.kind === "page")          return handlePageRoute(request, options, policy);
  // ...
}
```

`classifyRoute` is a pure function returning a discriminated union — easy to
unit-test exhaustively.

### CI check script

`scripts/check-route-guards.ts`:

1. Walk `src/app/api/**/route.ts`.
2. For each file, parse named exports `POST | PUT | DELETE | PATCH` using TS
   compiler API (`ts.createSourceFile` + AST traversal — not regex, to avoid
   string-literal false positives).
3. For each export, **collect the full HOF chain** (resolves F11/F13/T17).
   Two AST shapes appear in production composition:
   - Direct: `withSession(handler)` — `CallExpression` whose callee is an `Identifier`.
   - Curried (config-arg): `withRateLimit(rl, keyFn)(handler)` — `CallExpression`
     whose callee is itself a `CallExpression` whose callee is the `Identifier`.

   Walk the AST recursively from the export's right-hand-side:
   - If the node is a `CallExpression`:
     - Determine the HOF name:
       - If `callee` is an `Identifier` → HOF name is `callee.text`.
       - If `callee` is a `CallExpression` (curried form) → HOF name is
         `callee.expression.text` (the inner CallExpression's callee
         Identifier). Validate that this inner callee is itself an
         `Identifier`; if not, fail the route with "unsupported HOF AST shape".
       - Any other shape (e.g., property access `obj.method(handler)`,
         arrow function literal) → fail the route with "unsupported HOF AST shape".
     - Record the HOF name.
     - Descend into `node.arguments[0]` (the OUTER call's first argument is
       the next link in the chain, regardless of whether the outer call is
       direct or curried).
   - If the node is not a `CallExpression`, the chain terminates (this is
     the handler reference).
   - The result is an ordered list of HOF names from outermost to innermost.
4. For each export, look up the route's path glob in
   `scripts/route-guards-config.json` to obtain:
   - `requiredHOFs`: HOF names that MUST appear in the chain (e.g.,
     `withSession` for session-only destructive routes).
   - `forbiddenHOFs`: HOF names that MUST NOT appear in the chain (e.g.,
     `withOriginAssertion` for `withCheckAuth`-class routes).
   Reject the export if any required HOF is missing OR any forbidden HOF
   is present. The recursive collection from step 3 is what makes the
   `withOriginAssertion` exclusivity invariant enforceable — a chain
   `withRequestLog(withCheckAuth(withOriginAssertion(handler)))` would be
   rejected because the inner `withOriginAssertion` is recorded in the
   collected list.
5. If non-conforming, fail unless the file's relative path is in the
   allowlist.
6. **Allowlist matching is exact path match** (no glob, no prefix —
   resolves S10). `scripts/route-guards-allowlist.txt` format:
   each line is `path:reason` (e.g.,
   `src/app/api/auth/[...nextauth]/route.ts:library-managed by Auth.js`).
   The scanner compares the file's relative path string-equality against
   each allowlist line's path part. Prefix matching is explicitly NOT
   supported.

Add `npm run check:route-guards` and append to `scripts/pre-pr.sh` and
`.github/workflows/ci.yml`.

## Implementation steps

All work lands on a single branch `refactor/centralize-route-guards`. Steps are
grouped into two logical sets — **Plan 1** (HOF infrastructure + route migration
+ CI gate) and **Plan 2** (proxy modularization) — so the commit history can
be reviewed (and, if needed, split into two PRs) cleanly. Plan 1 commits land
first; Plan 2 commits land afterward on the same branch.

### Plan 1 — Centralize route guards

Closes pre1, F2, S1, R3 baseline.

**C1. Create HOF foundation** (`src/lib/http/guards/`).
   - `types.ts` — context types
   - `compose.ts` — type-safe `compose(g1, g2, g3)` helper
   - `with-session.ts` + `with-session.test.ts` (session-only auth).
     **Test cases**: session valid → ctx.auth populated, handler called;
     session absent → 401, handler NOT called.
   - `with-check-auth.ts` + test (1:1 wrapper for `checkAuth(req, { scope?, allowTokens? })`; preserves session-OR-extension-token semantics).
     **Test cases (resolves S7, T12)**:
     - session-only call (no options): valid session → handler called with `ctx.auth.type === "session"`; no session → 401.
     - token-aware call (`{ scope }`): valid extension Bearer with matching scope → handler called with `ctx.auth.type === "extension_token"`; valid Bearer with insufficient scope → 403; invalid Bearer → 401; no auth at all → 401.
     - token-aware call (`{ allowTokens: true }`): valid extension Bearer (any scope) → handler called; invalid Bearer → 401.
     - mixed call (session + Bearer both present): session takes precedence (existing `authOrToken` behavior, lines 64-68).
   - `with-origin-assertion.ts` + test (delegates to existing
     `src/lib/auth/session/csrf.ts`). **Test cases (resolves T2)**:
     - APP_URL set, matching origin → handler called
     - APP_URL set, mismatched origin → 403
     - APP_URL set, missing Origin → 403
     - APP_URL unset, Host present, derived origin matches → handler called (fallback path)
     - APP_URL unset, Host missing → 403
     - chrome-extension:// origin (boundary doc) → 403 (intended)
   - `with-rate-limit.ts` + test (delegates to existing
     `src/lib/security/rate-limit.ts`; `keyFn` receives `(req, ctx)`)
   - `with-maintenance-operator.ts` + test (delegates to existing
     `src/lib/auth/tokens/admin-token.ts` and
     `src/lib/auth/access/maintenance-auth.ts`).
     **Test cases (resolves S6)**:
     - missing Authorization header → 401
     - `Authorization: Bearer <wrong_secret>` → 401
     - valid token + missing operatorId in body → 400
     - valid token + non-admin operatorId → 400
     - valid token + deactivated admin → 400
     - valid token + active OWNER admin → handler called, `ctx.operator: { tenantId, role }` populated
   - `with-zod-body.ts` + test (delegates to existing
     `src/lib/http/parse-body.ts`)
   - `with-api-key.ts`, `with-mcp-token.ts`, `with-sa-token.ts`,
     `with-scim-token.ts` — wrappers around existing token validators
   - `index.ts` — barrel export
   - **Verification**: `npx vitest run src/lib/http/guards`,
     `npx next build`. No route handler changes in this commit.
   - **Commit**: `refactor(guards): introduce HOF wrapper foundation`

**C2. Migrate mutating routes to appropriate HOF chains** (the 8 R3-flagged routes — corrected from 9; member-key is GET-only and removed).

Per-route auth class assignment (resolves S1/F1, F3):

   *Session-only mutating routes* (use `withSession`):
   - `src/app/api/internal/audit-emit/route.ts` (POST) — closes pre1, S1.
     - Apply: `withRequestLog(withSession(withOriginAssertion(withRateLimit(...)
       (withZodBody(bodySchema)(handler)))))`.
     - **T3 (bundled)**: replace hardcoded `"PASSKEY_ENFORCEMENT_BLOCKED"`
       literals in `audit-emit/route.test.ts` (lines 31, 64, 91, 100, 110, 120,
       136) with `AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED` import.
   - `src/app/api/teams/route.ts` (POST) — currently uses bare `auth()`.
   - `src/app/api/teams/[teamId]/passwords/route.ts` (POST/PUT/DELETE) — POST uses bare `auth()`.
   - `src/app/api/teams/[teamId]/passwords/[id]/route.ts` (PUT/DELETE).
   - `src/app/api/passwords/[id]/route.ts` (**DELETE only**) — Session-only per
     the explicit deferral comment at line 220 (resolves S8). Token support
     deferred to Phase E pending `PASSWORDS_DELETE` scope. Apply
     `withRequestLog(withSession(withOriginAssertion(withRateLimit(...)(handler))))`.

   *Session-OR-extension-token routes* (use `withCheckAuth({ scope, allowTokens })` — NO `withOriginAssertion`, per the composition invariant above):
   - `src/app/api/api-keys/route.ts` (POST) — currently `checkAuth(req, { allowTokens: true })`. Apply: `withRequestLog(withCheckAuth({ allowTokens: true })(withRateLimit(...)(withZodBody(schema)(handler))))`.
   - `src/app/api/api-keys/[id]/route.ts` (DELETE) — same composition.
   - `src/app/api/passwords/route.ts` (POST) — currently `checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE })`. Apply: `withRequestLog(withCheckAuth({ scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE })(withRateLimit(...)(withZodBody(schema)(handler))))`.
   - `src/app/api/passwords/[id]/route.ts` (**PUT only**) — currently `checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE })`. Apply same composition as `passwords/route.ts` POST.

   *Per-handler split* (resolves S8 — `passwords/[id]/route.ts`):
   - PUT and DELETE in this file have DIFFERENT auth classes today and MUST keep that distinction.
   - The DELETE handler (line 220-225) carries the explicit comment `Session-only: token support for deletion deferred to Phase E (requires PASSWORDS_DELETE scope)` and calls `checkAuth(req)` with no options (session-only). `PASSWORDS_DELETE` scope does not exist in `EXTENSION_TOKEN_SCOPE` (`src/lib/constants/auth/extension-token.ts`), so `PASSWORDS_WRITE` MUST NOT be accepted for deletion.
   - **DELETE** must use the **session-only chain** (with `withOriginAssertion` since DELETE is destructive):
     - `src/app/api/passwords/[id]/route.ts` (DELETE) → listed below under *Session-only mutating routes*.

   *Removed from C2* (resolves F3):
   - ~~`src/app/api/teams/[teamId]/member-key/route.ts` (POST)~~ — file is GET-only; was a mis-listing in the original review.

   **Test mock strategy decision (resolves T1)**: All migrated route tests
   continue to mock the inner primitives (`@/lib/auth/session/check-auth`,
   `@/lib/auth/session/csrf`, `@/lib/security/rate-limit`) rather than the
   HOF wrappers. The HOF module barrel `src/lib/http/guards/index.ts` is
   never mocked in route tests. Rationale: HOFs delegate to those primitives,
   and existing mock declarations remain valid.

   **Existing test Origin handling (resolves T5, F12)**: `withOriginAssertion`
   rejects requests with missing or non-matching Origin. Update existing
   POST/PUT/DELETE test fixtures **for session-only routes** to include
   `headers: { origin: 'http://localhost:3000' }`. The complete list of
   session-only route test files to update:
   - `src/app/api/internal/audit-emit/route.test.ts`
   - `src/app/api/teams/route.test.ts`
   - `src/app/api/teams/[teamId]/passwords/route.test.ts`
   - `src/app/api/teams/[teamId]/passwords/[id]/route.test.ts`
   - `src/app/api/passwords/[id]/route.test.ts` — DELETE cases only (per S8 split)

   Add one new negative test per session-only route asserting cross-origin
   Origin → 403.

   **Session-OR-token routes** (api-keys, passwords) do NOT receive
   `withOriginAssertion`, so their existing tests do NOT need an Origin
   header. Their regression test is: valid extension Bearer call from
   `chrome-extension://abc...` Origin → 200 (must not be blocked by HOF
   chain).

   **Verification per route**:
   - `npx vitest run <route>.test.ts` — existing tests pass.
   - New negative test for cross-origin POST/PUT/DELETE → 403.
   - For session-OR-token routes: regression test for valid extension Bearer
     token call → 200 (must not be blocked by HOF chain).
   - **Commit**: `refactor(api): wrap mutating routes in guard HOFs (per auth class)`

**C3. Migrate maintenance / admin routes** to `withMaintenanceOperator`,
plus bundled small fixes on the maintenance surface (F1/S3, F3, T4).

   **C3 substep ordering** (T4 — Prisma migration must land first):

   1. **Prisma migration** (substep before route changes):
      - Add `AUDIT_LOG_PURGE` to the `AuditAction` enum in `prisma/schema.prisma`.
      - `npx prisma migrate dev --name add_audit_log_purge_action`.
      - **Verify the generated migration file exists** at
        `prisma/migrations/<timestamp>_add_audit_log_purge_action/migration.sql`
        and stage it explicitly (`git add prisma/migrations/...` AND
        `git add prisma/schema.prisma`) — Prisma does NOT automatically
        stage the migration file (resolves T13).
      - Run `npx prisma generate` so the TypeScript types pick up the new value.
      - Without this step, the `as const satisfies Record<AuditAction, AuditAction>`
        constraint on `AUDIT_ACTION` is a build-time blocker.
      - PostgreSQL note: `ALTER TYPE "AuditAction" ADD VALUE` is supported
        inside transactions on PG 12+ (project pins `postgres:16` in
        `docker-compose.yml`). Migration is reversible only via manual
        `ALTER TYPE ... DROP VALUE` against the live DB plus deletion of
        the generated migration file — Prisma does not generate a down
        migration. Document this if a revert is needed.

   2. **Constants + i18n + group registration** (F1/S3 — full enumeration, resolves F5):
      - `src/lib/constants/audit/audit.ts`:
        - Add `AUDIT_LOG_PURGE` to `AUDIT_ACTION` (line ~207) and `AUDIT_ACTION_VALUES`.
        - Register in `AUDIT_ACTION_GROUPS_TENANT.ADMIN` (line ~520) ONLY.
        - DO NOT add to `AUDIT_ACTION_GROUPS_PERSONAL.HISTORY` (line ~389) or
          `AUDIT_ACTION_GROUPS_TEAM.HISTORY` (line ~464) — audit log purge is
          tenant-admin scope only; the existing `HISTORY_PURGE` remains in
          PERSONAL/TEAM groups for password-history purge cases.
      - `messages/en/AuditLog.json`, `messages/ja/AuditLog.json` — add label entries.
      - **Forensic note (S4 — code comment)**: when defining `AUDIT_LOG_PURGE`,
        add a comment:
        ```ts
        // Audit log purges executed before this constant existed are recorded
        // under AUDIT_ACTION.HISTORY_PURGE with metadata.targetTable === 'auditLog'.
        // SIEM queries for audit-log destruction events must include both action
        // values for complete coverage.
        ```

   3. **Route migrations** to `withMaintenanceOperator`:
      - `src/app/api/maintenance/purge-history/route.ts`
      - `src/app/api/maintenance/purge-audit-logs/route.ts` — also switches
        from `HISTORY_PURGE` to `AUDIT_LOG_PURGE`.
      - `src/app/api/maintenance/dcr-cleanup/route.ts`
      - `src/app/api/maintenance/audit-outbox-purge-failed/route.ts`
      - `src/app/api/maintenance/audit-chain-verify/route.ts` — confirmed to
        exist (resolves S3); migration also closes the inline-helper
        divergence at lines 106-125.
      - `src/app/api/maintenance/audit-outbox-metrics/route.ts` — GET-only
        but currently uses inline `requireMaintenanceOperator`; migrate for
        uniformity (resolves F4). Note: GET handlers escape the C5 CI gate
        by design; this route is migrated explicitly here, not gated by CI.
      - `src/app/api/admin/rotate-master-key/route.ts` — closes F2.

   4. **F3 dryRun audit emission**:
      - `purge-history/route.ts` and `purge-audit-logs/route.ts`: emit a
        `logAuditAsync` call BEFORE the early return in the `dryRun` branch
        with `metadata.dryRun: true` and `metadata.matched: <count>`.
      - **Tests to invert (T3)**:
        - `purge-history/route.test.ts` lines 297-308 (`'does not log audit
          on dryRun'`): change `expect(mockLogAudit).not.toHaveBeenCalled()`
          to assert `logAuditAsync` IS called with
          `metadata.dryRun: true, metadata.matched: <count>`.
        - `purge-audit-logs/route.test.ts` lines 316-328: same inversion.

   5. **T4 maintenance-auth unit test**:
      - Add `src/lib/auth/access/maintenance-auth.test.ts` covering null
        membership, deactivated admin, MEMBER role, valid OWNER/ADMIN.
        Mock only Prisma.

   6. **Test consumer updates (T4 enumeration)**:
      - `src/lib/constants/audit/audit.test.ts:25` — `AUDIT_LOG_PURGE`
        will be in `AUDIT_ACTION_GROUPS_TENANT.ADMIN`, so it WILL appear
        in `adminActions`. Update the assertion to include it.
      - `src/components/settings/developer/tenant-webhook-card.test.tsx:163-164`
        — currently asserts `screen.getByText("HISTORY_PURGE")`. Tenant
        webhooks subscribe to tenant-admin actions, so `AUDIT_LOG_PURGE`
        WILL appear in the subscribable list. Update to assert both
        `HISTORY_PURGE` and `AUDIT_LOG_PURGE` appear.
      - `purge-audit-logs/route.test.ts:302` — change literal
        `"HISTORY_PURGE"` assertion to `"AUDIT_LOG_PURGE"`.
      - `purge-history/route.test.ts:284` — keeps `"HISTORY_PURGE"` (no
        change; password-history purge still uses the original action).
      - `src/__tests__/audit-i18n-coverage.test.ts` — passes automatically
        once both en/ja labels are added.
      - **`src/app/api/admin/rotate-master-key/route.test.ts`** (resolves T11/T15)
        — currently mocks `prisma.user.findUnique` for operatorId resolution
        (test setup at line 18). After C3 migration, the route uses
        `withMaintenanceOperator` which queries `prisma.tenantMember.findFirst`.
        Replace the entire `mockUserFindUnique` surface with
        `mockTenantMemberFindFirst`. **All tests that call `mockUserFindUnique`
        must be updated** (not just positive-path):
        - Positive-path tests: `mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "<uuid>", role: "OWNER" })`.
        - Negative-path test at line 149 (`returns 400 when operatorId does not exist`):
          `mockTenantMemberFindFirst.mockResolvedValue(null)` to drive the
          400 response from `withMaintenanceOperator`.
        - Remove `user: { findUnique: mockUserFindUnique }` from the Prisma
          mock setup (line 28); add `tenantMember: { findFirst: mockTenantMemberFindFirst }`.

   **Verification**:
   - `npx vitest run` (full suite — must pass after all updates)
   - `npx next build` (must pass — Prisma type integration)
   - `npm run test:integration`
   - `ADMIN_API_TOKEN=<hex> OPERATOR_ID=<uuid> scripts/purge-history.sh
     --dry-run` AND without dry-run → confirm both produce audit log entries.
   - `scripts/purge-audit-logs.sh` (dry-run + apply) → confirm
     `AUDIT_LOG_PURGE` appears in the dashboard UI.
   - **T9 — bypass-RLS gap note**: integration tests run as `passwd_app`
     (NOBYPASSRLS); the `withBypassRls` execution path in maintenance
     routes is NOT exercised by `npm run test:integration`. The shell-script
     verification above is the only automated check for that path. This
     limitation is accepted in scope and tracked under the deferred
     `pre2` redesign.
   - **Commit**: `refactor(api): migrate maintenance + close F1/S3/F2/F3/F4/T3/T4`

**C4. Migrate existing `assertOrigin` routes** to `withOriginAssertion`
   (uniformity; behavior unchanged). Resolves F2 — full enumeration from
   `grep -rn 'assertOrigin(' src/app/api`:
   - `src/app/api/vault/change-passphrase/route.ts`
   - `src/app/api/vault/unlock/route.ts`
   - `src/app/api/vault/rotate-key/route.ts`
   - `src/app/api/vault/admin-reset/route.ts`
   - `src/app/api/vault/recovery-key/generate/route.ts`,
     `recover/route.ts`
   - `src/app/api/vault/delegation/route.ts`,
     `[id]/route.ts`
   - `src/app/api/vault/reset/route.ts`
   - `src/app/api/auth/passkey/options/route.ts`,
     `email/route.ts`
   - `src/app/api/auth/passkey/verify/route.ts` — confirmed caller (was "if applicable")
   - `src/app/api/tenant/breakglass/route.ts` — added (was missing)
   - `src/app/api/tenant/breakglass/[id]/route.ts`
   - `src/app/api/tenant/audit-delivery-targets/route.ts`,
     `[id]/route.ts`
   - `src/app/api/tenant/members/[userId]/reset-vault/route.ts` — added (was missing)
   - `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/revoke/route.ts` — added (was missing)
   - `src/app/api/tenant/webhooks/route.ts` — added (was missing)
   - `src/app/api/teams/[teamId]/rotate-key/route.ts` — added (was missing)
   - `src/app/api/teams/[teamId]/webhooks/route.ts` — added (was missing)
   - `src/app/api/watchtower/alert/route.ts` — added (was missing)
   - `src/app/api/extension/bridge-code/route.ts` — confirmed caller (was "if applicable")
   - `src/app/api/mcp/authorize/consent/route.ts`
   - **Verification**: existing tests pass (mock strategy from C2 applies);
     no new behavioral tests required.
   - **Commit**: `refactor(api): migrate all assertOrigin routes to withOriginAssertion`

**C5. Add CI check + Plan 1 documentation**.
   - `scripts/check-route-guards.ts` — TS-AST-based scanner (uses
     `typescript` package, already a dev dep). Scope: `POST | PUT | DELETE
     | PATCH` handler exports under `src/app/api`. GET handlers are
     intentionally NOT covered (matches the threat model — GET handlers
     should not have CSRF / origin requirements).
   - **Initial allowlist generation (resolves F9)**: ~125 mutating routes
     using bare `auth()` or `checkAuth()` are not migrated in this PR
     (intentional scope boundary). Without seeding, the CI check would
     fail on every legacy route the moment C5 lands.
     - Add a `--generate-allowlist` mode to `check-route-guards.ts` that
       prints all currently-non-conforming routes with reason
       `legacy-not-yet-migrated`.
     - Run once: `node scripts/check-route-guards.ts --generate-allowlist
       > scripts/route-guards-allowlist.txt`.
     - Manually remove from the generated list any route that IS migrated
       in this PR (C2/C3/C4) — those must be enforced, not allowlisted.
     - Commit the populated allowlist alongside the CI check script.
     - Future PRs that migrate additional routes must remove the
       corresponding allowlist entries in the same commit.
   - `scripts/route-guards-config.json` — approved HOF names and required
     guard combinations per auth class. Maps each route path glob to the
     allowed HOF chain (e.g., `/api/passwords/**` → must include
     `withCheckAuth`, NOT `withSession`; `/api/internal/**` → must include
     `withSession`+`withOriginAssertion`). **MUST encode the
     `withOriginAssertion` exclusivity invariant**: any route mapped to
     `withCheckAuth`/`withMaintenanceOperator`/`withApiKey`/`withMcpToken`/
     `withSaToken`/`withScimToken` is rejected if its HOF chain also
     includes `withOriginAssertion`. Conversely, any route mapped to
     `withSession` for a destructive method MUST include `withOriginAssertion`.
   - `scripts/route-guards-allowlist.txt` — justified exceptions (e.g.,
     `[...nextauth]` library-managed).
   - **T7 — Permanent fixture test for the scanner**:
     - `scripts/check-route-guards.test.ts` with at least 7 fixture cases:
       - Conforming route (correct HOF chain) → exit 0.
       - Bare handler `export async function POST(req)` → exit 1 with
         expected error text.
       - Wrong HOF chain (e.g., `withSession` on a `/api/passwords` route
         which requires `withCheckAuth`) → exit 1.
       - **Exclusivity violation** — `withRequestLog(withCheckAuth(withOriginAssertion(handler)))`
         on a `/api/passwords/**` route → exit 1 with "exclusivity violation"
         error text. This validates the recursive chain traversal in step 3
         of the scanner spec.
       - **Curried HOF chain (full depth)** — full canonical chain
         `withRequestLog(withSession(withOriginAssertion(withRateLimit(rl, keyFn)(withZodBody(schema)(handler)))))`
         on a session-only destructive route → exit 0. Validates that the
         scanner correctly extracts `withRateLimit` and `withZodBody` from
         their curried-call AST shapes, AND walks at least 5 levels deep.
       - **Unsupported AST shape** — `export const POST = obj.method(handler)`
         (property-access callee) → exit 1 with "unsupported HOF AST shape".
       - Allowlisted exception → exit 0.
       - **Prefix-match negative case (resolves S10)** — a route at
         `src/app/api/foo/bar/route.ts` with NO allowlist match must not be
         silently exempted by an entry like `src/app/api/foo/route.ts:...` →
         exit 1 (confirms exact-match semantics).
     - Add to vitest run path in CI.
   - **S2 — CODEOWNERS protection** for guard infrastructure:
     - Add to `.github/CODEOWNERS`:
       ```
       /scripts/route-guards-allowlist.txt     @ngc-shj
       /scripts/route-guards-config.json       @ngc-shj
       /src/lib/http/guards/**                 @ngc-shj
       ```
   - `npm run check:route-guards` script in `package.json`.
   - Append to `scripts/pre-pr.sh`.
   - `.github/workflows/ci.yml` — add the check step to the `app-ci` job.
   - CLAUDE.md — add "Route Handler Guards" subsection under "Key Patterns";
     document composition order and rationale; document
     `npm run check:route-guards`. Document the auth-class disambiguation
     (`withSession` vs. `withCheckAuth`).
   - **Verification**: run check on the migrated codebase — must pass.
     Run `npx vitest run scripts/check-route-guards.test.ts` to verify the
     fixture-based scanner self-tests pass.
   - **Commit**: `chore(ci): enforce route guard adoption + document HOF pattern`

### Plan 2 — Modularize proxy.ts

Pure refactor — no behavior change. Lands after Plan 1 commits.

**C6. Extract `auth-gate` from proxy.ts**, plus T2 bundled.
   - `src/lib/proxy/auth-gate.ts` — move `getSessionInfo`, `sessionCache`,
     `setSessionCache`, `extractSessionToken`.
   - `src/proxy.ts` re-exports the test-only symbols (`_sessionCache`,
     `_setSessionCache`, `_extractSessionToken`) as a deprecation shim so
     `src/__tests__/proxy.test.ts` continues to pass without modification.
   - **T2 (bundled)** — add a TTL-expiry test in the new
     `src/lib/proxy/auth-gate.test.ts` using `vi.useFakeTimers` AND
     `vi.spyOn(globalThis, 'fetch')` (the cache-miss path triggers a DB
     re-fetch that must be observable). Estimated 40-50 lines including
     fetch mock + session response fixture. Test scenario: populate cache
     via `getSessionInfo`, advance time past `SESSION_CACHE_TTL_MS` (30,000
     ms), assert the next `getSessionInfo` issues a fresh fetch.
   - **Verification (resolves F7)**:
     - `npx vitest run` (full suite) — must pass.
     - `npx next build` — must pass.
   - **Commit**: `refactor(proxy): extract auth-gate module + T2 TTL test`

**C7. Extract `cors-gate` from proxy.ts**.
   - `src/lib/proxy/cors-gate.ts` — move `extensionTokenRoutes`,
     `isBearerBypassRoute`, and the preflight wiring block.
   - **Verification (resolves F7)**:
     - `npx vitest run` (full suite) — must pass.
     - `npx next build` — must pass.
   - **Commit**: `refactor(proxy): extract cors-gate module`

**C8. Extract `route-policy` from proxy.ts**.
   - `src/lib/proxy/route-policy.ts` — replace the long
     `pathname.startsWith(...)` chain with a `classifyRoute(pathname)` pure
     function returning a `RoutePolicy` discriminated union (`{kind:
     "preflight"|"public-share"|"api-bearer"|"api-session"|"page", ...}`).
   - Add `src/lib/proxy/route-policy.test.ts` with exhaustive case
     coverage.
   - **Verification (resolves F7)**:
     - `npx vitest run` (full suite) — must pass.
     - `npx next build` — must pass.
   - **Commit**: `refactor(proxy): extract route-policy classifier`

**C9. Extract `security-headers` + slim `proxy.ts`**, plus F4 and T1 bundled.
   - `src/lib/proxy/security-headers.ts` — move `applySecurityHeaders`
     (currently `proxy.ts:441-480`).
   - Refactor `proxy.ts` to compose the modules; target ≤ 100 lines.
   - Remove the deprecation shims from C6 once tests pass against the new
     module paths (update test imports in this commit).
   - **F4 (bundled)** — change `passkeyAuditEmitted` eviction from
     insertion-order FIFO to staleness-based: when at capacity, evict the
     entry whose `lastEmitted` is the furthest in the past, not the first
     inserted. Touches the eviction block at the current
     `proxy.ts:147-152` (relocated by this commit).
     - **Test for F4 (resolves T8)**: export `_passkeyAuditEmitted` from
       the new module as a test-only shim. Add test: fill map to
       `PASSKEY_AUDIT_MAP_MAX` with deliberately-non-monotonic
       `lastEmitted` timestamps, insert a new entry, verify the entry with
       the oldest `lastEmitted` is evicted (not the first-inserted).
   - **T1 (bundled)** — replace the hardcoded `SESSION_CACHE_MAX = 500`
     literal in `src/__tests__/proxy.test.ts:550` with an import from
     `@/lib/validations/common.server`. Apply the same change in the new
     `auth-gate.test.ts` if the constant is referenced there.
   - CLAUDE.md — update the proxy.ts description under "Architecture" to
     reflect the modularization (`auth-gate`, `cors-gate`, `route-policy`,
     `security-headers`).
   - **Verification**: `npm run pre-pr` (full lint + tests + build + checks).
   - **Commit**: `refactor(proxy): orchestrate via extracted modules + close F4/T1/T8`

## Testing strategy

### Unit tests (vitest)

Per HOF in `src/lib/http/guards/*.test.ts`:

- `with-session`: session valid → ctx.auth populated, handler called; session
  absent → 401, handler not called.
- `with-check-auth` (resolves T12/T14): full case list in C1. Session-only call
  (valid session → handler called with `ctx.auth.type === "session"`; no session
  → 401); token-aware `{ scope }` (valid Bearer with matching scope → handler
  called with `ctx.auth.type === "extension_token"`; insufficient scope → 403;
  invalid Bearer → 401; **no auth at all → 401**); token-aware `{ allowTokens:
  true }` (valid Bearer → handler called; **invalid Bearer → 401**); mixed call
  (session + Bearer → session takes precedence per existing `authOrToken`).
- `with-origin-assertion`: full case list in C1 — matching origin → handler called;
  mismatched → 403; missing → 403; APP_URL fallback path (Host present) → handler
  called; Host missing → 403; chrome-extension:// origin → 403 (intended for
  session-only routes only — Bearer-aware routes do NOT compose this HOF, see
  composition invariant).
- `with-rate-limit`: under limit → handler called; over limit → 429 with
  Retry-After header; key function receives correct ctx.
- `with-maintenance-operator`: full case list in C1 — missing Authorization →
  401; wrong Bearer → 401; missing operatorId → 400; non-admin operatorId → 400;
  deactivated admin → 400; valid OWNER → handler called with `ctx.operator: { tenantId, role }`.
- `with-zod-body`: valid body → ctx.body populated; invalid → 400 with Zod
  error shape.
- `compose`: type augmentation flows correctly across multiple HOFs (test via
  type-level assertions using `expectTypeOf`).

### Integration tests

- Re-run `npm run test:integration` against real Postgres after each step.
- Add an integration test for `audit-emit` with mismatched origin → 403 (locks
  in the new defense).

### Regression tests

- `src/__tests__/proxy.test.ts` — verify all existing assertions still pass
  after modularization. Update import paths only where the test relies on
  module-internal symbols.
- All existing route handler tests (`*/route.test.ts`) must pass without
  modification of their assertion logic. Per the C2 mock-strategy decision,
  tests continue to mock the inner primitives (`@/lib/auth/session/check-auth`,
  `@/lib/auth/session/csrf`, etc.) — the HOF module barrel is NEVER mocked
  in route tests. Most existing mock declarations remain valid; only Origin
  header fixture additions (T5) are needed for session-only routes.

### CI gate verification

- Add a deliberately-broken commit during local testing: a new
  `src/app/api/test-unwrapped/route.ts` with bare `export async function POST`.
- Confirm `npm run check:route-guards` exits non-zero with the expected error.
- Revert before committing to the branch.

### Manual smoke test

After full migration, exercise these flows in the dev environment:

1. Browser session POST to `/api/passwords` (create entry) → 200 with
   encrypted blob.
2. Browser session POST to `/api/internal/audit-emit` from same origin → 200.
3. Curl POST to `/api/internal/audit-emit` with `Origin: http://evil.com` →
   403.
4. `scripts/purge-history.sh` with valid token + active admin operatorId →
   purges, audit log entry written.
5. `scripts/rotate-master-key.sh` with valid token + deactivated admin
   operatorId → 400 (was 200 before — F2 fix).
6. Extension token POST to `/api/passwords` from `chrome-extension://...`
   origin → 200 (Bearer-bypass route, no origin check required).

## Considerations & constraints

### Risks

- **R1 — Behavior drift in HOF migration**: a wrapper that subtly reorders
  side effects (e.g., logging before vs. after auth check) could regress
  audit logs.
  - Mitigation: keep order identical to current inline ordering. Verify by
    diffing the response (status, headers, body) for known fixture requests
    pre/post migration via integration tests.

- **R2 — TypeScript HOF type erasure**: composition of multiple `Guard<CIn,
  COut>` HOFs is non-trivial to type. Loss of the augmented context type
  forces handlers to use `as` casts.
  - Mitigation: use `compose<G1, G2, G3>(g1, g2, g3)` with explicit generics,
    backed by `expectTypeOf` tests. Reference TypeScript's
    `Pipeable`/`flow` patterns.

- **R3 — proxy.ts test exports break**: `_sessionCache`, `_setSessionCache`,
  `_extractSessionToken`, `_applySecurityHeaders` are exported for test
  access (`src/proxy.ts:485-486`).
  - Mitigation: re-export from `proxy.ts` as a deprecation shim for the
    duration of this PR. Plan 2 (follow-up) removes the shim and points tests
    at the new modules directly.

- **R4 — CI check false positives / negatives**: AST-based detection may
  miss novel composition patterns (e.g., a custom HOF wrapper that re-exports
  an approved HOF) or flag legitimate non-mutating handlers.
  - Mitigation: start with strict pattern (`export const POST = wrapperName(`
    or `export const POST = compose(...)(`); allowlist for documented
    exceptions; iterate after first false positive.

- **R5 — Bundle size impact**: HOFs add a thin closure layer per route. For
  ~50+ routes, total overhead is O(KB).
  - Mitigation: measure before/after via `npx next build` output. Reject if
    > 0.5% growth on route-handler bundle.

- **R6 — Bearer-only routes regression**: extension/MCP/SCIM/SA token routes
  do not use session auth and should not have `withSession` applied. Applying
  the wrong HOF chain is a security regression (locks out legitimate token
  callers).
  - Mitigation: per-route auth class is documented in the route-policy
    module. The CI check verifies the correct HOF chain matches the route's
    auth class.

- **R7 — Concurrent merges during refactor**: a coworker's in-flight PR may
  add a new route handler that lacks the new wrapper.
  - Mitigation: merge this plan's PR before any concurrent route-adding PR.
    Coordinate via the merge-freeze process if needed.

### Items pulled in from the original out-of-scope list

After re-evaluating size and risk, the following small fixes are bundled
into the natural commit (rather than deferred):

| Item | Bundled into | Size estimate |
|------|--------------|---------------|
| F1 / S3 — distinct `AUDIT_LOG_PURGE` action | C3 | Prisma migration + constant + i18n + 1 route line + ~5 test consumer updates |
| F3 — dryRun audit log entry | C3 | ~10 lines × 2 routes + 2 test inversions |
| T4 — `requireMaintenanceOperator` unit test | C3 | ~50 lines new test |
| T3 — audit-emit test imports `AUDIT_ACTION` | C2 | ~7 line edits |
| T2 — TTL expiry test (`vi.useFakeTimers` + fetch spy) | C6 | ~40-50 lines new test |
| T1 — `SESSION_CACHE_MAX` import in proxy.test | C9 | 1 line |
| F4 — `passkeyAuditEmitted` staleness eviction + T8 test | C9 | ~5 lines fix + ~20 lines test |

### Genuinely out of scope (tracked separately)

These remain deferred because the fix is non-trivial or carries regression
risk that requires its own design discussion:

- **S2** — CSP `form-action` localhost allowance in production. The current
  unconditional allowance supports OAuth 2.1 native-app callbacks (RFC 8252
  family — *citation unverified, please confirm in the follow-up plan*).
  Removing it from production CSP risks breaking the CLI / native client
  callback flow. Needs an explicit decision on whether localhost callback
  is a supported production flow, or whether the CSP can be tightened by
  detecting the dev profile.
- **pre2** — 30 s session-revocation cache bypass window. Requires
  migrating the in-process `Map` cache to Redis with active invalidation;
  multi-worker coordination design needed.
- **pre3** — `operatorId` body field vs. token-bound claim. Requires
  redesigning `ADMIN_API_TOKEN` to a per-operator signed token (JWT or
  similar) so the claimed operator identity is cryptographically bound to
  the token holder; non-trivial migration with operational impact (existing
  shell scripts hold a single shared token).

These will be addressed in subsequent PRs after `centralize-route-guards`
lands. Each will reference this plan's structural foundation.

### Recurring-issue obligations addressed by this plan

- **R3 (Pattern propagation)**: HOF + CI gate makes propagation impossible to
  miss for future routes. Existing routes are explicitly enumerated in step 3.
- **R17 (Helper adoption coverage)**: step 5 enumerates ALL existing
  `assertOrigin` call sites and migrates each.
- **R22 (Perspective inversion)**: step 3's enumeration includes both the
  forward pattern (`checkAuth` followed by data mutation) and the inverted
  pattern (sites where `checkAuth` is via a different identifier like `auth()`
  or `getServerSession()`).
- **R19 (Test mock alignment)**: per the C2 mock-strategy decision, route
  tests continue to mock the inner primitives (`checkAuth`, `assertOrigin`,
  rate limiters); the HOF barrel `src/lib/http/guards/index.ts` is never
  mocked. This keeps existing mock declarations valid and avoids barrel
  drift. HOF unit tests (in `src/lib/http/guards/*.test.ts`) cover HOF
  behavior independently; route tests verify route handler logic with
  mocked primitives.

## User operation scenarios

The following scenarios test both the migration's behavior preservation and
the new defense:

### Scenario 1: Browser session-authenticated mutation (preservation)

- **Setup**: signed-in user with unlocked vault.
- **Action**: create a password entry via `POST /api/passwords` from the
  dashboard UI.
- **Expected (before & after)**: 200 with the new entry's id; audit log entry
  with `actorType: HUMAN`, action `PASSWORD_ENTRY_CREATED`.

### Scenario 2: Cross-origin CSRF attempt on internal endpoint (new defense)

- **Setup**: signed-in user, attacker page at `https://evil.com`.
- **Action**: attacker page issues `fetch("https://app.example.com/api/internal/audit-emit", { method: "POST", credentials: "include", ... })`.
- **Expected (before)**: SameSite=lax + CSP `connect-src 'self'` block this
  in modern browsers, but defense-in-depth is missing — a future browser
  policy gap or subdomain takeover could open this.
- **Expected (after)**: 403 from `withOriginAssertion`, regardless of cookie
  / CSP layer status.

### Scenario 3: Maintenance API via shell script (preservation)

- **Setup**: operator with `ADMIN_API_TOKEN` and an active admin's UUID.
- **Action**: run `scripts/purge-history.sh`.
- **Expected (before & after)**: same 200 with `purged: N`; same audit log
  entry; same exit code.

### Scenario 4: rotate-master-key with deactivated admin (F2 fix)

- **Setup**: operator with `ADMIN_API_TOKEN`; an admin user previously
  deactivated (`deactivatedAt != null`).
- **Action**: `POST /api/admin/rotate-master-key` with that user's UUID as
  `operatorId`.
- **Expected (before)**: 200 (User.findUnique returns the row regardless of
  deactivation).
- **Expected (after)**: 400 (`withMaintenanceOperator` filters
  `deactivatedAt: null` and `role IN [OWNER, ADMIN]`).

### Scenario 5: Extension Bearer-token call (preservation, no false positive)

- **Setup**: chrome-extension with valid extension Bearer token.
- **Action**: `POST /api/passwords` from extension content script
  (origin `chrome-extension://abc...`).
- **Expected (before & after)**: 201 with new entry; no `assertOrigin`
  rejection.
- **Why this works**: per the composition invariant, `passwords` routes
  use `withCheckAuth({ scope })` and do NOT include `withOriginAssertion`
  in their HOF chain. The proxy's Bearer-bypass path
  (`proxy.ts:241-245`) handles ingress; the route handler authenticates
  via `withCheckAuth` (which calls `checkAuth(req, { scope })`). Origin
  assertion is bypassed not because the proxy strips it, but because
  Bearer-aware routes are explicitly designed to omit
  `withOriginAssertion` (Bearer callers are not subject to cookie-CSRF).

### Scenario 6: CI gate catches new unwrapped route

- **Setup**: developer adds `src/app/api/example/route.ts` with bare
  `export async function POST(req) { ... }`.
- **Action**: `npm run check:route-guards` (or `npm run pre-pr`).
- **Expected (after this plan)**: exits non-zero with message
  `src/app/api/example/route.ts: POST handler is not wrapped in an approved
  guard. Add withSession/withOriginAssertion/withRateLimit or document the
  exception in scripts/route-guards-allowlist.txt.`

### Scenario 7: Migration step rollback

- **Setup**: a step (say step 3, route migration) introduces a regression
  caught by integration tests post-merge.
- **Action**: `git revert` the step's commit.
- **Expected**: routes return to their prior state (using inline
  `checkAuth`/`assertOrigin`); HOF infrastructure remains; CI check
  temporarily allowlists the reverted routes until the issue is resolved.
