# Plan: session-api-passkey-gate

Issue `#959`. It was split out of the `#956` plan review (session findings S1, S8–S10, S12–S14,
F9–F12, F15–F17, F19, TQ1–TQ4). It depends on `#961` and `#966` (both merged). The bearer side
is `#965`. Revision 3 follows plan review round 2. Findings are cited by ID from the review
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
  - The dedup key is `userId:blockedPath`.
  - Page navigations keep their existing path.
- **D5 — enrollment is bound to recency (S2).** While `passkeyEnforcementBlocks` holds,
  `webauthn/register/options` and `register/verify` require `requireRecentSession`. A session
  cookie alone cannot clear the gate or mint a durable credential. The minimal screen answers
  `SESSION_STEP_UP_REQUIRED` through `handleStepUpError`, which offers a fresh sign-in.
  - Both server calls carry `@stepup id:… method:POST` markers, and the card's two calls carry
    the matching client markers, so `check-step-up-client-coverage.sh` stays green (N3).
- **D6 — the blocked verdict is computed on the server (N1).** The `auth.ts` session callback
  adds `passkeyBlocked: boolean`, from `passkeyEnforcementBlocks` on the server clock, next to
  the four passkey fields. Client code reads that verdict and never re-derives it from the raw
  fields with the browser clock.

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
  3. An invalid session gives 401 for API_SESSION_REQUIRED. For API_DEFAULT it passes through
     to the route's own auth, except when the request carries a session-name cookie that
     `readSessionCookie` refuses (ambiguous or chunked). That gets 401 too, because the route's
     `auth()` could still resolve a session the gate never evaluated (S12). Legitimate clients
     never send such a cookie.
  4. The IP restriction (API_SESSION_REQUIRED, unchanged).
  5. Tier B.
  6. The own-gate set (T16): passes through, the route answers in its own shape.
  7. `passkeyEnforcementBlocks(session)` → 403 (D3) with audit (D4).
- **Own-gate routes**, each with its reason recorded. The proxy fetches the session and passes
  the request through, and the route refuses in its own shape:
  - `mobile/authorize` (iOS redirect);
  - `mcp/authorize` and `mcp/authorize/consent` (OAuth error shape).
- **Early returns that read a session:** `extension/bridge-code` and `v1/openapi.json` never
  reach C1 (T16). `v1/openapi.json`, when private, accepts a session, so it gains its own
  session passkey check (S7), tested at the route level.
- **Fail-closed bundle (S8/N2):** the `auth.ts` catch path marks the bundle it substitutes on a
  transient fault (`passkeyStateDegraded: true`). `getSessionInfo` caches a bundle only for
  `NEGATIVE_CACHE_TTL_MS` (5 s), not the positive TTL, when it substituted the bundle itself
  (missing fields) or when the response carries that marker. So a transient session-callback
  fault does not lock every tenant out for 30 s.
- **Control class:** enforceable boundary for cookie-bearing `/api/*` requests. The adjudicators
  are `classifyRoute`, the two exemption tiers, and `getSessionInfo`'s fail-closed state.

### C2 — the recovery screen and client

- **Dashboard layout:** `src/app/[locale]/dashboard/layout.tsx` already calls `auth()`. When
  `session.passkeyBlocked` holds, it renders `PasskeyRequiredScreen` instead of
  `<VaultGate><DashboardShell>`: a registration card and sign-out.
- **Admin layout (N4):** `src/app/[locale]/admin/layout.tsx` redirects a blocked session to the
  passkey page, matching the page proxy. Its own `auth()` is fresh where the proxy's view may be
  cached.
- **`VaultProvider` (F1/S3/N1):** `VaultStatus` keeps its existing values. When the session
  reports `passkeyBlocked`, the provider only skips the initial `/api/vault/status` fetch. So
  the root provider issues no gated call on the minimal screen or any other page.
  - It does not change an existing unlocked state, and auto-lock keeps running for a user who
    becomes blocked while unlocked.
  - `VaultGate` never renders on the minimal screen, so it never sees the unfetched status.
- **`fetchApi` reaction (F16, F1):**
  - On a 403 whose JSON `error` is `PASSKEY_REQUIRED`, it calls `hardNavigate` to the passkey
    page. It does this only when the current locale-stripped path is under `/dashboard` or
    `/admin` and is not already the passkey page, and at most once per page load.
  - The body is read from a clone inside a try/catch. The reaction never throws (T5), and the
    response reaches the caller unchanged.
  - Non-dashboard pages are not bounced.
- **Card (F3, F2):**
  - `PasskeyCredentialsCard` registers while the vault is locked, skipping the PRF wrap.
  - Navigation after success is an `onRegistered` callback that only the minimal screen passes.
    The settings page keeps today's behaviour.
  - **PRF signal (N5):** the client sends `prfCapable`, taken from the registration
    ceremony's `getClientExtensionResults().prf?.enabled`. `register/verify` stores
    `prfSupported = hasWrap || prfCapable` and keeps the salt, so the existing re-bootstrap is
    offered once the vault is unlocked.
    - The flag is an unsigned client hint that only decides whether the offer appears;
      re-bootstrap runs its own PRF ceremony.
    - The offer's copy for a credential with no wrap does not claim a key rotation (en and ja).
- **Session cache (F5/F19/N6):** on success, `register/verify` calls a new
  `invalidateUserSessionsCache(userId)` in `user-session-invalidation.ts`. It is the sibling of
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
  blocked session gets 403 `PASSKEY_REQUIRED`, unless it is a Tier A or Tier B entry, an
  own-gate route, or an early-return kind.
- I2 (pinned by C4): the exempt sets equal a literal list in the test. No exempt entry has a
  method on a vault, tenant, key-minting or webauthn-delete route, apart from
  `DELETE /api/vault/delegation`.
- I3: a Tier A target never triggers `getSessionInfo`.
- I4: while blocked, registration requires a recent sign-in.
- I5: the client never re-derives the blocked verdict; it reads `passkeyBlocked`.

## Acceptance criteria

In a tenant past its grace period, for a member without a passkey, with a session cookie:

- Refused with body `PASSKEY_REQUIRED`, plus one blocked audit row per
  `userId:method:routeKey` window, for:
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

- **Manifest-declared oracle (T1/T3/T4/S7/T16–T18):**
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
  - A handler scan pins every API_DEFAULT or early-return route that reads a session as an
    own-gate route or an exemption (S13/T19).
    - It is an AST scan that resolves each call to its import declaration, scope-aware.
    - The reader set is defined by defining module: `@/auth#auth`, `checkAuth`, `authOrToken`,
      the `session-cookie` / `getSessionToken*` exports, and `requireRecentSession`.
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
    - an ambiguous session cookie on API_DEFAULT gives 401 (S12);
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
  - Layouts: both branches of the dashboard and admin layouts (T13, N4).
  - `VaultProvider`: skips the status fetch when `passkeyBlocked`, and keeps an existing
    unlocked state and auto-lock (N1).
  - Card: offers PRF re-bootstrap after unlock for a credential with `prfSupported` and no wrap
    (T23).
  - Card: registers while locked; calls `onRegistered` only when given.
- **Route unit:** `register/options` and `register/verify` require recency when blocked (and not
  when allowed); `register/verify` bulk-invalidates the user's sessions on success only and
  stores the PRF capability without the wrap; `v1/openapi.json`'s session passkey check.
- **Integration (real DB and Redis; a skip is not a pass) (T9):** `register/verify` with
  `verifyRegistration` stubbed:
  - primed cache entries for two of the user's sessions are tombstoned on success;
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
  - let an ambiguous cookie pass through on API_DEFAULT.
  
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
| C1 | proxy gate, two-tier exemption, order, own-gate routes, fail-closed TTL | pending |
| C2 | minimal screen, admin layout, VaultProvider skip, server verdict, fetchApi reaction, card, PRF signal, user cache invalidation, recency + step-up markers | pending |
| C3 | stale comments and policy doc | pending |
