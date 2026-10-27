# Plan: session-api-passkey-gate

Issue `#959`. It was split out of the `#956` plan review (session findings S1, S8–S10, S12–S14,
F9–F12, F15–F17, F19, TQ1–TQ4). It depends on `#961` and on issue `#966` (fixed by PR `#967`,
merged). The bearer side is `#965`. Revision 6 follows plan review round 5. Findings are cited by ID from the review
record.

`#966` (round-2 S9) is a precondition of D5: an OAuth callback no longer links an IdP account
to the signed-in user, so "sign in again" cannot be satisfied by attaching an attacker's IdP
account to a stolen blocked session.

## Project context

- Type: web app (Next.js 16 proxy + App Router, Prisma 7, PostgreSQL RLS, Redis session cache).
- Test infrastructure: unit + real-DB integration + Playwright E2E + CI.
- Verification environment constraints:
  - E1: WebAuthn registration in E2E needs a CDP virtual authenticator, which is Chromium only,
    and `WEBAUTHN_RP_ID` in the CI `e2e` job, which is not set today (T7). This plan adds both,
    so the path is `verifiable-local` and `verifiable-CI`.
  - Everything else is `verifiable-local` and `verifiable-CI`.

## Objective

After a tenant's `requirePasskey` grace period expires, a member without a passkey is
redirected when they navigate to a page, but their session cookie still opens every `/api/*`
route. Close that gap at the proxy, and keep a working, recency-bound path for registering a
passkey.

## Decisions

- **D1 — the gate sits in the proxy.** `handleApiAuth` is the one place every cookie-bearing
  `/api/*` request passes. Routes that own a different response shape keep their own gate (C1).
- **D2 — recovery while the vault is locked (user decision).** A blocked user gets a minimal
  registration screen outside `VaultGate` and the dashboard shell, and registers without
  unlocking. A blocked session touches no vault data endpoint.
- **D3 — refusal shape.** 403 `API_ERROR.PASSKEY_REQUIRED`, `Cache-Control: no-store`,
  CORS-wrapped like the proxy's other refusals.
- **D4 — audit is emitted directly by the gate (S6/F7).** `api-route.ts` already reaches
  `logAuditAsync` through `checkAccessRestrictionWithAudit`, so the gate needs no self-fetch.
  - Metadata keeps the shape every other emitter uses (N7): `{ blockedPath }`, where
    `blockedPath` is `"<METHOD> /api/<routeKey>"`.
  - `routeKey` comes from a closed set (S11): the top-level directory names under
    `src/app/api/`, held as a constant and pinned against the filesystem by a test. Any other
    first segment becomes `other`. It never holds an ID or caller-chosen text.
  - `<METHOD>` comes from a closed set too: `GET`, `POST`, `PUT`, `PATCH` and `DELETE`, with
    anything else written as `OTHER`.
  - The write is bounded by the Redis-shared limiter `passkey-gate.ts` already uses (N-R3-2):
    key `rl:passkey_session_gate_audit:<userId>:<blockedPath>`, `max: 1`, window
    `PASSKEY_AUDIT_DEDUP_MS`. It is not bounded by the per-process dedup map, which ordinary
    traffic would thrash at this cardinality.
  - No row is written for a degraded bundle (D7).
  - Page navigations keep their existing path, except that they also write no row for a
    degraded bundle.
- **D5 — enrollment is bound to recency (S2).** Registration always requires a recent
  sign-in (user decision 2026-10-27, code review round 1 SEC-1): `webauthn/register/options`
  and `register/verify` require `requireRecentCurrentAuthMethod` unconditionally, not only
  while `passkeyEnforcementBlocks` holds, as credential delete already does.
  That is the provider-aware freshness check every other step-up route and the sign-in reauth
  panel use, so the gate and the page cannot disagree and loop (R5-3). A session
  cookie alone (older than `STEP_UP_WINDOW_MS`) cannot mint a durable credential, so it cannot
  clear the gate with one either. The minimal screen answers
  `SESSION_STEP_UP_REQUIRED` through `handleStepUpError`, which offers a fresh sign-in.
  - Both server calls carry `@stepup id:… method:POST` markers, and the card's two calls carry
    the matching client markers, so `check-step-up-client-coverage.sh` stays green (N3).
- **D6 — the blocked verdict is computed on the server (N1).** The `auth.ts` session callback
  adds `passkeyBlocked: boolean`, from `passkeyEnforcementBlocks` on the server clock, next to
  the four passkey fields. Client code reads that verdict and never re-derives it from the raw
  fields with the browser clock.
  - `passkeyBlocked` is false for a degraded bundle; the separate `passkeyStateDegraded` flag
    carries that state (D7).
  - `passkeyBlocked` is a display verdict only (S-R4-2/N-R4-4). No server code authorizes on
    it. Server decisions (the API gate, the admin layout redirect, own-gate routes) use
    `passkeyEnforcementBlocks` over the raw fields, or `derivePasskeyState`. Both stay closed
    for a degraded bundle. D5 reads no passkey state at all (it always requires recency), so
    it requires recency during an outage too.
- **D7 — a degraded passkey state is an outage, not a requirement (N-R3-1).**
  - **The marker:** when the session callback cannot read the passkey state, the `auth.ts` catch
    path keeps the fail-closed bundle, adds `passkeyStateDegraded: true`, and sets
    `passkeyBlocked: false`.
  - **Who carries it:** `SessionInfo`, `SessionInfoSchema` and the session type all carry the
    flag.
  - **API gate:** it still fails closed, but answers 503 `SERVICE_UNAVAILABLE` (no-store, no
    audit row). A transient fault therefore neither shows "register a passkey" to tenants that
    never required one, nor reloads their tabs and locks their vaults, nor writes false audit
    rows.
  - **Layouts:** they render a "temporarily unavailable, retry" state in place, instead of the
    dashboard or the minimal screen.
  - **The `fetchApi` reaction:** it ignores 503.
  - **Page proxy (N-R4-3):** on a degraded bundle it neither redirects nor writes a row. It lets
    the navigation through to the layouts, which re-check with a fresh `auth()`; the layouts are
    already the D2 enforcement point. The user keeps their URL, and a tenant that never required
    passkeys never lands on the passkey page.

## Contracts

### C1 — proxy session gate (`src/lib/proxy/api-route.ts`)

- **Applies to** every `/api/*` request that carries a session cookie and reaches the point
  after:
  - the early returns (PUBLIC_SHARE, PUBLIC_RECEIVER, API_V1, bridge-code);
  - the CSRF gate;
  - the Bearer-only bypass;
  - the exchange return.

  This covers API_SESSION_REQUIRED and API_DEFAULT alike. A cookie plus a junk Bearer header is
  gated.
- **Two-tier exemption** (F4/S1/T15), as method-aware, exact `(method, path)` entries, each with
  a reason:
  - **Tier A — pre-session bypass.** Skips all of C1. These are the requests the proxy itself
    makes, and Auth.js's own handler paths. All of them are API_DEFAULT, so no IP restriction
    applied to them before this change either. Every `/api/auth/*` path is enumerated. There is
    no prefix match, so a new `/api/auth/*` route is gated until it is listed (S4). The two
    provider-parameterised actions match exactly one further segment (`signin/<id>`,
    `callback/<id>`), segmented the way Auth.js parses them (N8):
    - Auth.js, with methods:
      - `GET` and `POST` on `session`; `POST` is `useSession().update()`;
      - `GET` on `csrf`, `providers`, `error` and `verify-request`;
      - `GET` and `POST` on `signin`, `POST` on `signin/<id>`;
      - `GET` and `POST` on `callback/<id>`;
      - `GET` and `POST` on `signout`;
    - the three pre-auth passkey sign-in routes;
    - `POST /api/internal/audit-emit`, the page proxy's self-fetch.
    - Passkey reauth (`/api/auth/passkey/reauth/*`) is not exempt.
  - **Tier B — passkey-only exemption.** Consulted only at the passkey step, after the 401 and
    IP checks still apply. These are what the minimal screen and the root providers call (S5/F6):
    - `GET /api/webauthn/credentials`
    - `POST /api/webauthn/register/options`
    - `POST /api/webauthn/register/verify`
    - `GET /api/user/auth-provider`
    - `DELETE /api/vault/delegation`, which `VaultProvider`'s lock and pagehide handlers call
  - **Not exempt:** per-ID revocations, extension Bearer routes, `passkey-status`, and every
    vault, tenant, key-minting or webauthn-delete route.
- **Order:**
  1. Tier A.
  2. `getSessionInfo`.
  3. An invalid session gives 401 for API_SESSION_REQUIRED, as today. For API_DEFAULT, the
     rule keys on whether the route reads the session, not on why the session is invalid
     (S12/N-R3-8/S-R3-1/S-R4-1/N-R4-1/N-R4-2):
     - **Why not a reason:** the proxy cannot tell "no session" from a fault. Auth.js answers a
       swallowed adapter error with the same 200-`null` as a dead token. A deactivated member
       is invalid at the proxy while the route's `auth()` still resolves the session.
     - **Session readers:** a literal `API_DEFAULT_SESSION_READERS` list in the proxy (today
       `POST /api/auth/passkey/reauth/options` and `POST /api/auth/passkey/reauth/verify`).
       - `mobile/autofill-token` read the session through `checkAuth` → `authOrToken`, but
         only ever authorized an `IOS_APP` token.
       - It becomes bearer-only through `validateExtensionToken` (scope and `clientKind`
         checked), like its sibling mobile routes. It keeps its `PASSKEY_REQUIRED` mapping and
         leaves the reader set (R5-1).
       - A session-only request still gets 401, as today.
       There, any invalid session (missing, ambiguous, dead, faulted or deactivated) gets 401.
       The route's `auth()` never sees a session this gate did not evaluate.
     - **Own-gate routes** pass through to their own auth, which re-derives the passkey state
       itself (N-R3-5).
     - **Every other API_DEFAULT route** reads no session, so an invalid or stale cookie passes
       through as today: it cannot authenticate anything there.
     - **Pinning:** the handler scan (Testing) proves the reader set; see I1.
  4. The IP restriction (API_SESSION_REQUIRED, unchanged).
  5. Tier B.
  6. The own-gate set (T16): passes through, the route answers in its own shape.
  7. A degraded bundle → 503 (D7). Tier B and own-gate routes, reached before this step, decide
     on the raw fields (D6), so they stay closed while degraded.
  8. `passkeyEnforcementBlocks(session)` → 403 (D3) with audit (D4).
- **Own-gate routes**, each with its reason recorded. The proxy fetches the session and passes
  the request through, and the route refuses in its own shape:
  - `mobile/authorize` (iOS redirect);
  - `mcp/authorize` and `mcp/authorize/consent` (OAuth error shape).
  - Every own-gate route must make an import-bound call to `passkeyEnforcementBlocks`, the
    refusing predicate, not just `derivePasskeyState`. So an own-gate entry cannot wave a route
    through (T-R3-1/T-R4-6).
  - Passkey reauth (`/api/auth/passkey/reauth/*`) stays `gated` and is an
    `API_DEFAULT_SESSION_READERS` entry.
- **Early returns that read a session:** `extension/bridge-code` and `v1/openapi.json` never
  reach C1 (T16). `v1/openapi.json`, when private, accepts a session, so it gains its own
  session passkey check (S7), tested at the route level.
- **Fail-closed bundle (S8/N2):** `getSessionInfo` caches a bundle only for
  `NEGATIVE_CACHE_TTL_MS` (5 s), not the positive TTL, in two cases: when it substituted the
  bundle itself (missing fields, also marked degraded), or when the response carries
  `passkeyStateDegraded`. So a transient session-callback fault is short-lived and is answered
  as an outage (D7).
- **Control class:** enforceable boundary for cookie-bearing `/api/*` requests. The adjudicators
  are `classifyRoute`, the two exemption tiers, and `getSessionInfo`'s fail-closed state.

### C2 — the recovery screen and client

- **Dashboard layout:** `src/app/[locale]/dashboard/layout.tsx` already calls `auth()`, and it
  decides on the raw fields, as the admin layout does (D6, R5-2):
  - degraded first: it renders the retry state (D7);
  - otherwise, when `passkeyEnforcementBlocks` holds, it renders `PasskeyRequiredScreen` (a
    registration card and sign-out) instead of `<VaultGate><DashboardShell>`.
- **Admin layout (N4):** `src/app/[locale]/admin/layout.tsx` redirects a blocked session to the
  passkey page, matching the page proxy. Its own `auth()` is fresh where the proxy's view may be
  cached.
- **`VaultProvider` (F1/S3/N1/N-R3-3):** `VaultStatus` keeps its existing values. On every run
  of its status effect (which re-runs on each session update), while the session reports
  `passkeyBlocked` or is degraded:
  - it skips `/api/vault/status`;
  - it moves `LOADING` to `LOCKED`, so the retry and fallback timers never arm;
  - it never changes an existing unlocked state; auto-lock keeps running for a user who becomes
    blocked while unlocked.
- **Pollers (N-R4-5):** `TeamVaultProvider` and `EmergencyAccessProvider` suspend their gated
  polling under the same predicate as `VaultProvider`: `passkeyBlocked` or degraded. So the root providers issue no gated call on any page, whether the
  user started locked or unlocked.
- **`fetchApi` reaction (F16, F1):**
  - On a 403 whose JSON `error` is `PASSKEY_REQUIRED`, it calls `hardNavigate` to the passkey
    page. It does this only when the current locale-stripped path is under `/dashboard` or
    `/admin`, `PasskeyRequiredScreen` is not mounted, and at most once per page load.
  - The exclusion is keyed on a flag the mounted screen sets, not on the pathname (N-R3-4). A
    soft navigation keeps the old dashboard layout on the passkey URL, so that stale shell
    hard-reloads once into the minimal screen, and the latch prevents a loop.
  - The body is read from a clone inside a try/catch. The reaction never throws (T5), and the
    response reaches the caller unchanged.
  - Non-dashboard pages are not bounced.
- **Card (F3, F2):**
  - `PasskeyCredentialsCard` registers while the vault is locked, skipping the PRF wrap.
  - Navigation after success is an `onRegistered` callback that only the minimal screen passes.
    The settings page keeps today's behaviour.
  - `onRegistered` awaits `update()`, then calls `hardNavigate` to the current path. The client
    session then drops `passkeyBlocked`, and the vault status (including `SETUP_REQUIRED`) and
    the tenant auto-lock apply (N-R4-6). The screen-mounted flag clears on unmount.
  - **PRF signal (N5/N-R3-6):** `register/verify` derives the PRF capability from the
    `clientExtensionResults.prf` it already receives (`enabled === true`, or `results`
    present), the same way it reads `credProps`. It adds no separate body field.
    - It stores `prfSupported = hasWrap || prfEnabled` and keeps the salt, still checked by
      `PER_CRED_SALT_HEX_RE`, under that same condition. So the existing re-bootstrap is offered
      once the vault is unlocked.
    - The value is client-supplied and decides only whether the offer appears. Re-bootstrap
      runs its own verified PRF ceremony.
    - The offer's copy for a credential with no wrap does not claim a key rotation (en and ja).
- **Session cache (F5/F19/N6/S-R3-2):** every writer of `hasPasskey` calls a new
  `invalidateUserSessionsCache(userId)` in `user-session-invalidation.ts` once it succeeds:
  - `register/verify`;
  - the credential `DELETE` (`webauthn/credentials/[id]`), so deleting the last passkey after
    grace is not served `hasPasskey: true` from cache.
  
  User deletion cascades the sessions away with the user. It is the sibling of
  `invalidateTenantSessionsCache` and tombstones every live session of the user through
  `invalidateCachedSessionsBulkByDigest`.
  - It is deliberately cross-tenant, because `hasPasskey` counts a passkey under any tenant.
  - It runs under its own bypass grant, scoped to `session`.
  - So the layout, the page proxy and the API gate all see `hasPasskey` on the next request.
  - If invalidation fails, that is logged, and the entries expire within
    `SESSION_CACHE_TTL_MS`.

### C3 — stale text

- `src/auth.ts`: correct the tenant-move comment that claims the proxy reads the requirement
  "on every request".
- `src/lib/proxy/page-route.ts`: correct the passkey-status comment (F8).
- `docs/security/policy-enforcement.md`, `requirePasskey` row:
  - add the session `/api/*` gate and the layout enforcement point;
  - remove the `#959` caveat and the unused passkey-status banner claim.

## Invariants

- I1 (app-enforced, gated by the C4 manifest table): every cookie-bearing `/api/*` request from a
  blocked session gets 403 `PASSKEY_REQUIRED`. The exceptions:
  - a Tier A or Tier B entry;
  - an own-gate route, which refuses in its own shape;
  - an early-return kind;
  - a degraded bundle (503).

  On API_DEFAULT, an invalid session never reaches a route that reads the session. The
  `API_DEFAULT_SESSION_READERS` list equals the set the handler scan finds (API_DEFAULT routes
  that read a session and are neither Tier A nor own-gate), so a new reader cannot be added
  without joining it.
- I2 (pinned by C4): Tier A, Tier B and the own-gate set each equal a literal list in the test.
  No entry in them has a method on a vault, tenant, key-minting or webauthn-delete route, apart
  from `DELETE /api/vault/delegation`.
- I3: a Tier A target never triggers `getSessionInfo`.
- I4: registration always requires a recent sign-in (user decision 2026-10-27).
- I5: the client never re-derives the blocked verdict; it reads `passkeyBlocked`.

## Acceptance criteria

In a tenant past its grace period, for a member without a passkey, with a session cookie:

- Refused with body `PASSKEY_REQUIRED`, plus one blocked audit row per `userId:blockedPath`
  window across processes, for:
  - `GET /api/passwords`;
  - `GET /api/vault/status`;
  - `PUT /api/tenant/policy`, sent with a matching Origin so CSRF passes.
- A cookie plus a junk Bearer header on a Bearer-eligible route gives `PASSKEY_REQUIRED`.
  Bearer-only requests are not gated here (`#965`).
- Each Tier B entry answers as its route does. A non-exempt method on an exempt path, for
  example `DELETE /api/webauthn/credentials/[id]`, gives `PASSKEY_REQUIRED`.
- A Tier B route keeps its existing outcome for a denied IP (`ACCESS_DENIED`) and for an invalid
  session (401).
- `/dashboard/...` shows the minimal screen, which issues no 403. Registration:
  - with a sign-in older than the step-up window, it asks for a fresh sign-in;
  - with a fresh sign-in and the vault locked, it succeeds;
  - after it, the next `/api/passwords` call is allowed.
- After unlocking, PRF re-bootstrap is offered for the new credential.
- Allowed, with no gate effect: inside the grace period, with the requirement off, or with a
  passkey (including one under another tenant).

## Testing strategy

- **Manifest-declared oracle (T1/T3/T4/S7/T16–T18, T-R3-1, T-R3-8):**
  - Each route in `scripts/checks/route-policy-manifest.json` gains a required per-method
    `sessionPasskeyGate` field. Its values are `gated`, `tier-a`, `tier-b`, `own-gate` or
    `early-return`, each with a reason where it is not `gated`.
  - Each value has one proxy-observable outcome, a pair of (response, session fetch) (T16):

    | Value | Response | Session fetch |
    |-------|----------|---------------|
    | `gated` | 403 `PASSKEY_REQUIRED` | yes |
    | `tier-a` | pass | no |
    | `tier-b` | pass | yes |
    | `own-gate` | pass | yes |
    | `early-return` | pass | no |

  - Catch-all routes declare `concretePaths` (`{ path, method, outcome }`), required whenever the
    route directory has a `[...x]` segment. The table iterates them, including negative
    spellings next to each wildcard entry (T17).
    - For such routes the table evaluates only `concretePaths` and skips the derived UUID path.
    - Parity requires `concretePaths` to cover every declared method (T-R3-8).
  - `tier-b` and `own-gate` look the same at the proxy. So the own-gate set is pinned in I2, and
    each own-gate route is required to call the passkey adjudicator, checked by AST with
    import binding (T-R3-1).
  - A new parity assertion: the declared methods equal `methods` in both directions, every value
    is in the enum, and every non-`gated` value has a reason. A missing declaration fails; it is
    not skipped (T18). `ManifestEntry`, the `$schema-note`, and the security-matrix generator are
    updated together.
  - A table test runs the real `handleApiAuth` and the real `getSessionInfo` (session-cache
    mocked, fetch dispatched by URL) for every (route, method), with a blocked session cookie.
    It asserts the declared outcome. Columns: cookie, cookie + junk Bearer, and Bearer-only
    (pass-through, no session fetch) over the manifest's `bearerBypass` entries.
  - The fixture stubs `APP_URL`, sends a matching `Origin`, and allows the IP restriction.
    Every deny asserts the body `PASSKEY_REQUIRED` and that the session fetch happened (T2).
  - I2 is a literal snapshot of both tiers plus the denylist.
  - A handler scan pins every session reader that the proxy does not gate (S13/T19, T-R3-2,
    N-R3-7). A reader declared `tier-a` or `early-return` is either in a literal
    reader-exemption list with a reason (for example `audit-emit`), or calls the passkey
    adjudicator itself (`openapi.json`, `bridge-code`). `own-gate` readers pass.
    - A `gated` API_DEFAULT reader must be in `API_DEFAULT_SESSION_READERS`, and the list must
      hold nothing else. `gated` API_SESSION_REQUIRED readers pass.
    - A catch-all reader (`[...nextauth]`) is classified by its reader-exemption entry, with a
      reason. Its `gated` negative spellings do not make it a list member (R5-4).
    - It is an AST scan that resolves each call to its import declaration, scope-aware.
    - The reader set is defined by defining module: `@/auth#auth`, `checkAuth`, `authOrToken`,
      the `session-cookie` / `getSessionToken*` exports, `requireRecentSession`,
      `requireRecentCurrentAuthMethod`, `evaluateStepUpFreshness` and
      `canRecoverSessionWithPasskey` (R5-3).
    - Wrappers are not followed transitively; that floor is documented.
    - Red-proved with an aliased import and a local shadow.
- **Proxy unit:**
  - A shared session-fixture builder with required passkey fields, producing full `SessionInfo`
    values for cache hits too (T5).
  - A fetch mock that dispatches on pathname, with a fresh `Response` per call (T6).
  - `_resetPasskeyAuditForTests` in every gate suite.
  - Cells:
    - deny and allow;
    - grace boundary under fake timers (T11);
    - Tier A issues no session fetch (I3);
    - Tier B keeps the 401 and `ACCESS_DENIED`;
    - API_DEFAULT with a cookie;
    - audit dedup and bounded metadata;
    - the fail-closed bundle cached for 5 s, both when substituted and when marked
      `passkeyStateDegraded` (N2/T20);
    - on an `API_DEFAULT_SESSION_READERS` route, each `valid:false` source gives 401. The
      sources are:
      - ambiguous cookie;
      - 200-`null`, both for a dead token and for a swallowed adapter fault;
      - a non-ok fetch;
      - deactivated member (`resolveUserTenantId` null);
      - a `resolveUserTenantId` throw;
      - a negative-cache hit.
    - a control: the same stale cookie on a non-reader API_DEFAULT route passes through;
    - `mobile/authorize` (the API_DEFAULT own-gate route) passes with an ambiguous cookie;
      `mcp/authorize` (API_SESSION_REQUIRED) gives 401 (T-R3-6/T-R4-1/T-R4-7);
    - a degraded bundle gives 503 with no audit row. The flag is carried end to end:
      - a session response with `passkeyStateDegraded: true` through the real `getSessionInfo`;
      - a marked entry round-tripped through the real `SessionInfoSchema`.

      Neither uses an injected fixture (T-R4-2).
    - page proxy: a degraded bundle neither redirects nor fetches `audit-emit`; positive control
      is a blocked, non-degraded bundle that does both (T-R4-4/N-R4-3);
    - the audit write goes through the Redis limiter key (N-R3-2). The cross-process property
      is proven in the real-Redis integration suite: two independently loaded gate instances
      refusing the same `userId:blockedPath` produce exactly one `audit_outbox` row (T-R4-3);
    - OPTIONS with a blocked cookie gives 204 with no session fetch (T26);
    - `routeKey` collapses an unknown segment to `other` (S11).
  - Exempt-predicate cells for spellings no route has (T12).
- **Existing tests that change (T5):**
  - `api-route.test.ts`: the valid-session allow cell; the `mobile/authorize` cell.
  - `proxy.test.ts`:
    - access-restriction allow;
    - duplicate-cookie control;
    - CSRF session GET;
    - the session-cache fetch count;
    - the CORS POST;
    - the `toHaveBeenCalled()` fetch assertions.
  - The `getCachedSession` fixtures missing passkey fields.
  - `passkey-credentials-card.test.tsx`: the locked-disabled cell inverts, and its
    `url-helpers` mock gains `hardNavigate`.
  - `use-bulk-action.test.ts`: plain-object 403s, which need the reaction's try/catch.
- **Client unit:**
  - `fetchApi`: navigates once on `PASSKEY_REQUIRED` under `/dashboard`; does not navigate on
    other 403s, on the passkey page, off `/dashboard`, or on an unreadable body; the caller can
    still read the body.
  - Layouts: the blocked, allowed and degraded branches of the dashboard and admin layouts
    (T13, N4, D7).
  - `VaultProvider`:
    - skips the status fetch on every run while `passkeyBlocked`;
    - moves `LOADING` to `LOCKED`;
    - keeps an existing unlocked state and auto-lock (N1/N-R3-3).

    The degraded flag has the same effect. The team and emergency-access pollers suspend while
    blocked or degraded (T-R4-4/N-R4-5).
  - Every client verdict cell sets `passkeyBlocked` opposite to what the raw fields would give
    under the test clock, so re-deriving the verdict goes red (I5, T-R3-7).
  - `fetchApi` (T-R4-5):
    - ignores 503;
    - with the screen-mounted flag set, it does not navigate;
    - on the passkey URL with the flag unset (a stale shell), it navigates exactly once.

    This replaces the earlier "on the passkey page" cell.
  - Card: `onRegistered` awaits `update()` before `hardNavigate` (N-R4-6).
  - Card: offers PRF re-bootstrap after unlock for a credential with `prfSupported` and no wrap
    (T23).
  - Card: registers while locked; calls `onRegistered` only when given.
- **`auth.ts` producer (T-R3-3):**
  - session-callback cells for `passkeyBlocked` equal to `passkeyEnforcementBlocks` at the grace
    boundary on a fixed clock;
  - for the catch path, `passkeyStateDegraded: true` with `passkeyBlocked: false`;
  - the existing "passkey enforcement fail-closed" block in `auth.test.ts` joins the
    inventory.
- **Route unit:** `register/options` and `register/verify` always require recency (user
  decision 2026-10-27; stale, boundary and webauthn-verified cells over the real helper); `register/verify` derives `prfSupported` from `clientExtensionResults.prf`
  (T-R3-5); the credential `DELETE` invalidates the user's sessions; with a degraded bundle and a
  stale sign-in, both register calls answer `SESSION_STEP_UP_REQUIRED` (S-R4-2/N-R4-4);
  `mobile/autofill-token` keeps its outcomes with `validateExtensionToken`. Those are a session
  alone gives 401, an `IOS_APP` token mints, other client kinds and missing scope are refused,
  and a blocked member gets `PASSKEY_REQUIRED`. A stale cookie plus a valid `IOS_APP` token
  still mints (R5-1); `register/verify` bulk-invalidates the user's sessions on success only and
  stores the PRF capability without the wrap; `v1/openapi.json`'s session passkey check.
- **Integration (real DB and Redis; a skip is not a pass) (T9):** `register/verify` with
  `verifyRegistration` stubbed:
  - primed cache entries for two of the user's sessions, under different tenants, are tombstoned
    on success (T-R3-9);
  - they are untouched on failure;
  - another user's entry is untouched.
  
  An `auth.ts` cell: a passkey under another tenant counts (T13).
- **E2E (Playwright, E1) (T7/T8/T21–T23).** The harness mechanics are Phase 2 work. These are
  the obligations it must meet:
  - The RP ID and origin come from one place used by both CI and the local invocation
    (`WEBAUTHN_RP_ID=localhost`).
  - The virtual authenticator matches the server options (user verification required, resident
    key) and has PRF.
  - Each attempt (including a retry) uses its own user, so the audit dedup cannot suppress the
    row; the row is read by polling.
  - "No 403 on the minimal screen" has a positive control: the card's Tier B fetch answering 200
    and the card rendered. Only after that does it assert zero `PASSKEY_REQUIRED` and no request
    to `/api/vault/status`.
  - The audit check matches `metadata.blockedPath === "GET /api/passwords"`, taken after the API
    call, because the page proxy writes the same action (T-R3-4).
  - After registration, `/api/passwords` answers 200 (T-R3-10). After unlock, the PRF
    re-bootstrap offer appears for the PRF authenticator (T-R3-5).
  - The seed helpers take a `tenantId`, and cleanup covers a dedicated tenant seeded past grace.
  - `beforeEach` deletes the user's credentials and uses a fresh session.
  - The spec covers:
    - API `PASSKEY_REQUIRED`;
    - the minimal screen issuing no 403;
    - a stale sign-in asked to sign in again;
    - registration with a fresh sign-in and the vault locked;
    - the unlock prompt shown afterwards;
    - the audit row as an `audit_outbox` delta.
- **Red proofs on a scratch copy (T10):**
  - remove the gate;
  - move Tier A after `getSessionInfo`;
  - restore the cookie+Bearer bypass;
  - limit the gate to API_SESSION_REQUIRED;
  - make the exemption path-only;
  - flip one route's declared outcome;
  - add `GET /api/vault/status` to Tier B;
  - remove the recency check;
  - remove the bulk invalidation;
  - make the `fetchApi` reaction apply to any 403, or remove it;
  - remove the layout branch (dashboard and admin);
  - attempt the PRF wrap while locked;
  - move Tier B before `getSessionInfo` or the IP check;
  - widen Tier A to an `/api/auth/` prefix (the reauth cells go red);
  - remove the `VaultProvider` skip;
  - replace `onRegistered` with an unconditional navigation;
  - store `prfSupported` from the wrap only;
  - put the raw path in the audit metadata or dedup key;
  - remove the `v1/openapi.json` session check;
  - drop the own-gate step;
  - revert the 5 s TTL for the marked bundle;
  - let an ambiguous cookie pass through on a reader route;
  - answer 401 to a stale cookie on a non-reader API_DEFAULT route (the control cell goes red);
  - add a vault route to the own-gate set;
  - drop the degraded marker from the `auth.ts` catch bundle, or set `passkeyBlocked` true there;
  - answer a degraded bundle with `PASSKEY_REQUIRED`;
  - bound the audit write with the in-process map only;
  - re-derive the verdict in `VaultProvider`;
  - make `invalidateUserSessionsCache` tenant-scoped;
  - skip invalidation on the credential `DELETE`;
  - drop a route from `API_DEFAULT_SESSION_READERS`;
  - restore `checkAuth` in `mobile/autofill-token` (the scan goes red);
  - make the dashboard layout read `passkeyBlocked`, or check degraded after blocked;
  - make D5 use the createdAt-only `requireRecentSession`;
  - pass a 200-`null` through on a reader route;
  - let D5 read `passkeyBlocked`;
  - redirect a degraded page navigation;
  - key the `fetchApi` exclusion on the pathname;
  - accept `derivePasskeyState` alone in the own-gate AST check;
  - remove the `passkeyEnforcementBlocks` call from `mcp/authorize/consent`, or alias its
    import;
  - drop the degraded flag in `getSessionInfo` or `SessionInfoSchema`.
  
  Each red proof names the cell expected to go red (T24).
- **Harness obligations for Phase 2** (T25, T27–T29):
  - The real-`getSessionInfo` table mocks session-cache, `resolveUserTenantId` (a non-null
    tenant), `checkAccessRestrictionWithAudit` and `logAuditAsync`, and nothing else.
  - The inventory also covers `auth-gate.test.ts` (C4 block); the stale "positive-cached by
    design" comment in `auth-gate.ts`; and a dedup test probe for the `blockedPath` key shape.
  - The `fetchApi` once-per-load latch gets a test reset. Navigation is observed through the
    `window.location` stub.
  - The Redis integration cell fails rather than skips under `CI` without `REDIS_URL`. Its
    blocked session is a real Session row with a recent `createdAt`, so the recency check
    passes.

## Considerations & constraints

- SC1: bearer credentials are `#965`.
- SC2: presentation in the iOS app and the browser extension is `#963`.
- SC3: `POST /api/internal/audit-emit` accepting forged blocked rows from any session predates
  this plan (Adj1). It is noted for a follow-up, not changed here.
- Behaviour change: a blocked member's open dashboard tabs navigate to the passkey page at their
  next API call.

## User operation scenarios

- An admin enables `requirePasskey` with a 7-day grace period. After it, a passkey-less member's
  next dashboard navigation, or the next API call from an open tab, lands on the minimal screen.
  - If their sign-in is older than the step-up window, they sign in again.
  - They then register a passkey, with the vault locked or not, and continue.
  - Later, with the vault unlocked, the passkey page offers PRF auto-unlock.
- A blocked admin cannot change the tenant policy through the API.
- A blocked member can sign out. While the vault is open, locking it still revokes delegation.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | proxy gate, two-tier exemption, order with invalid-reason handling, own-gate routes with route-level adjudication, degraded 503, fail-closed TTL, Redis-bounded audit | pending |
| C2 | minimal screen, admin layout, degraded retry state, VaultProvider + pollers, server verdict, fetchApi reaction (mounted flag), card, server-derived PRF signal, user cache invalidation on register and delete, recency + step-up markers | pending |
| C3 | stale comments and policy doc | pending |

## Implementation Checklist

### Batch 1a — proxy and session plumbing
- **Session callback (`src/auth.ts`):**
  - adds `passkeyBlocked` and `passkeyStateDegraded`;
  - its catch path sets degraded and `passkeyBlocked: false`;
  - C3 tenant-move comment.
- **Types:** `src/types/next-auth.d.ts` gains both fields.
- **Session cache:** `src/lib/auth/session/session-cache.ts`: `SessionInfo` and
  `SessionInfoSchema` gain `passkeyStateDegraded`.
- **`src/lib/proxy/auth-gate.ts`:**
  - carries the flag;
  - a substituted or marked bundle gets `NEGATIVE_CACHE_TTL_MS`;
  - stale "positive-cached by design" comment.
- **New `src/lib/proxy/session-passkey-gate.ts`:**
  - Tier A, Tier B, own-gate and `API_DEFAULT_SESSION_READERS` as literal method-aware
    entries;
  - the `routeKey` and method closed sets;
  - `blockedPath`;
  - the Redis-limited audit write.
- **`src/lib/proxy/api-route.ts`:** the C1 order.
- **`src/lib/proxy/page-route.ts`:** degraded means no redirect and no audit; F8 comment.
- **Reuse:**
  - `passkeyEnforcementBlocks`, `isPasskeyGracePeriodExpired` (`passkey-enforcement.ts`);
  - `createRateLimiter` (see the `passkey-gate.ts` audit limiter);
  - `logAuditAsync` and `personalAuditBase`;
  - `AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED`;
  - `errorResponse`, `API_ERROR.PASSKEY_REQUIRED` and `API_ERROR.SERVICE_UNAVAILABLE`;
  - `applyCorsHeaders`;
  - `NEGATIVE_CACHE_TTL_MS`;
  - `PASSKEY_AUDIT_DEDUP_MS`.

### Batch 1b — routes and invalidation
- **`register/options` and `register/verify`:**
  - `requireRecentCurrentAuthMethod` when `derivePasskeyState` blocks, with `@stepup`
    markers and `stepup-route-paths.json`;
  - `register/verify` also gets the PRF derivation from `clientExtensionResults.prf` and the
    user cache invalidation.
- **`src/app/api/webauthn/credentials/[id]/route.ts`:** `DELETE` invalidates the user cache.
- **`src/app/api/mobile/autofill-token/route.ts`:** bearer-only through
  `validateExtensionToken`.
- **`src/app/api/v1/openapi.json/route.ts`:** session passkey check.
- **`src/lib/auth/session/user-session-invalidation.ts`:** `invalidateUserSessionsCache`, with
  a new grant in `tenant-rls-grants.ts` (`session` only) and the bypass allowlist.
- **`docs/security/policy-enforcement.md`:** C3.

### Batch 2 — client
- **Layouts:**
  - `src/app/[locale]/dashboard/layout.tsx` and `admin/layout.tsx` decide on the raw fields,
    degraded first;
  - `PasskeyRequiredScreen` and a retry state.
- **Providers:**
  - `src/lib/vault/vault-context.tsx`;
  - `team-vault-core.tsx` and `emergency-access-context.tsx` suspend while blocked or degraded.
- **`src/lib/url-helpers.ts` / `fetchApi`:** the reaction, the screen-mounted flag, and a test
  reset for the latch.
- **`passkey-credentials-card.tsx`:**
  - register while locked;
  - `onRegistered` (`update()`, then `hardNavigate`);
  - client `@stepup` markers with `handleStepUpError`.
- **Messages:** `messages/{en,ja}/*`, with copy that claims no key rotation.

### Batch 3 — gates and tests
- **Manifest:**
  - `scripts/checks/route-policy-manifest.json` gains `sessionPasskeyGate` and
    `concretePaths`;
  - `src/__tests__/proxy/route-policy-manifest.test.ts` gets parity, the outcome table and the
    I2 snapshot;
  - the security-matrix generator is updated with it.
- **Handler scan:** an AST scan with import binding (reader set, `API_DEFAULT_SESSION_READERS`
  equality, own-gate adjudicator).
- **Integration:**
  - `register/verify` cross-tenant invalidation;
  - the two-instance Redis audit bound.
- **E2E:** `e2e/` spec with RP ID, a PRF virtual authenticator, a user per attempt, and the
  positive control.

### CI parity
- `scripts/pre-pr.sh` ran all 86 gates green on PR `#967`, and its gate list matches CI.
- New gates join through the existing manifest test and vitest, so no new CI-only gate is added.
