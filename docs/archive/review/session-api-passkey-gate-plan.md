# Plan: session-api-passkey-gate

Issue `#959`. It was split out of the `#956` plan review (session findings S1, S8–S10, S12–S14,
F9–F12, F15–F17, F19, TQ1–TQ4). It depends on `#961` (one session-cookie reader), which is
merged. The bearer side is `#965`.

## Project context

- Type: web app (Next.js 16 proxy + App Router, Prisma 7, PostgreSQL RLS, Redis session cache).
- Test infrastructure: unit + real-DB integration + Playwright E2E + CI.
- Verification environment constraints:
  - E1: WebAuthn registration in E2E needs a CDP virtual authenticator (Chromium only). The repo
    has none today; this plan adds one, so the path is `verifiable-local` and `verifiable-CI`.
  - Everything else is `verifiable-local` and `verifiable-CI`.

## Objective

After a tenant's `requirePasskey` grace period expires, a member without a passkey is
redirected to the passkey page when they navigate. Their session cookie still opens every
`/api/*` route, though: vault reads and writes, minting API keys and operator tokens, and for
an admin, turning the requirement off through `/api/tenant/policy`.

Close that gap at the proxy, the single ingress, and keep a working path for the user to
register a passkey.

## Decisions

- **D1 — the gate sits in the proxy, not in the routes.** `handleApiAuth` is the one place every
  cookie-bearing `/api/*` request passes, so the class is enforced structurally. Routes that own a
  different response shape keep their own gate (C1).
- **D2 — recovery happens while the vault is locked (user decision).** A blocked user gets a
  minimal registration screen outside `VaultGate` and the dashboard shell. They register a passkey
  without PRF. PRF auto-unlock is set up later through the existing re-bootstrap. As a result:
  - the server exempt set holds only registration, sign-out and self-revocation;
  - a blocked session touches no vault endpoint at all.
- **D3 — refusal shape.** 403 `API_ERROR.PASSKEY_REQUIRED`, `Cache-Control: no-store`,
  CORS-wrapped like the proxy's other refusals. Audit goes through the proxy's existing
  `/api/internal/audit-emit` self-fetch, deduplicated by `recordPasskeyAuditEmit`.

## Contracts

### C1 — proxy session gate (`src/lib/proxy/api-route.ts`)

- **Applies to** every `/api/*` request that carries a session cookie (`hasSessionCookie`) and
  reaches the point after:
  - the early returns (PUBLIC_SHARE, PUBLIC_RECEIVER, API_V1, bridge-code);
  - the CSRF gate;
  - the Bearer bypass (`hasBearer && isBearerRoute && !cookiePresent`);
  - the exchange return.

  This covers API_SESSION_REQUIRED and API_DEFAULT alike. A cookie plus a junk Bearer header is
  gated (S8).
- **Order:**
  1. The exempt check runs on `(method, pathname)` before `getSessionInfo`, so the proxy's own
     `/api/auth/session` and `audit-emit` fetches never recurse or get refused (S9/F10/F11).
  2. `getSessionInfo`.
  3. For API_SESSION_REQUIRED, an invalid session is the 401 it is today. For API_DEFAULT, an
     invalid session passes through to the route's own auth.
  4. The IP restriction, unchanged, for API_SESSION_REQUIRED.
  5. The passkey check: `passkeyEnforcementBlocks(session)` → 403 (D3).
- **Control class:** enforceable boundary for cookie-bearing `/api/*` requests. The adjudicator
  is `classifyRoute`, together with the exempt predicate. The session state comes from
  `getSessionInfo`, which already fails closed when its passkey fields are missing.
- **Routes that keep their own gate**, with each reason recorded beside the exempt set:
  - `mobile/authorize`: a 302 to the iOS callback;
  - `mcp/authorize` and `mcp/authorize/consent`: the OAuth error shape;
  - `extension/bridge-code`: CORS and its own client mapping. It takes the bridge-code early
    return, so it never reaches C1.
- **Exempt set:** method-aware `(method, path pattern)` entries in one `ReadonlySet`-backed
  predicate, each with a reason. The set is derived from what the C2 screen and sign-out call:
  - the `/api/auth/` prefix: Auth.js, the session read, sign-out, and the proxy self-fetch;
  - `POST /api/internal/audit-emit`: the proxy self-fetch;
  - `GET /api/user/passkey-status`: how the C2 screen learns its state;
  - `GET /api/user/auth-provider`;
  - `GET /api/webauthn/credentials`;
  - `POST /api/webauthn/register/options`;
  - `POST /api/webauthn/register/verify`;
  - self-revocation:
    - `DELETE /api/sessions`
    - `DELETE /api/sessions/[id]`
    - `DELETE /api/vault/delegation`
    - `DELETE /api/vault/delegation/[id]`
    - `DELETE /api/extension/token`
    - `POST /api/extension/key/reset`
    - `DELETE /api/user/mcp-tokens/[id]`

  Vault endpoints, tenant admin, key minting and webauthn deletion are never exempt.

### C2 — the recovery screen (client)

- **Dashboard layout:** `src/app/[locale]/dashboard/layout.tsx` already calls `auth()`. When
  `passkeyEnforcementBlocks` holds for the session, it renders a minimal `PasskeyRequiredScreen`
  instead of `<VaultGate><DashboardShell>`. The screen has a registration card and sign-out, and
  makes no other API call. The page proxy already redirects every non-exempt dashboard path to
  the passkey page.
- **Registration while locked:** `PasskeyCredentialsCard` allows registration when the vault is
  locked. It skips the PRF wrap when there is no secret key. On success it navigates with
  `hardNavigate` to the dashboard, so the layout re-evaluates.
- **Open tabs (F16):** `fetchApi` gains one reaction. A 403 whose JSON `error` is
  `PASSKEY_REQUIRED` triggers `hardNavigate` to the passkey page, at most once per page load.
  The body is read from a clone, and the response is returned unchanged to the caller. Bearer
  clients are unaffected: they do not use `fetchApi`.
- **Session cache (F19):** `webauthn/register/verify` invalidates the caller's own session cache
  entry on success, so the layout and the proxy see `hasPasskey` at once. The user's other
  sessions converge within `SESSION_CACHE_TTL_MS` (30 s), which is stated as accepted.

### C3 — stale text

- `src/auth.ts`: correct the comment that says the proxy reads the requirement "on every request"
  (it is the tenant-move block). The proxy now reads it on every cookie-bearing request, through
  the 30 s cache.
- `src/lib/proxy/page-route.ts`: correct the passkey-status comment.
- `docs/security/policy-enforcement.md`: in the `requirePasskey` row, the session `/api/*` gate
  replaces the "`#959`" caveat.

## Invariants

- I1 (app-enforced, by the proxy and the C4 manifest table test): every cookie-bearing `/api/*`
  request from a blocked session gets 403 `PASSKEY_REQUIRED`, unless its `(method, path)` is in
  the exempt set or the route is one of the own-gate routes.
- I2: an exempt entry never covers a vault, key-minting or tenant-admin route (pinned by the
  same table).
- I3: the proxy's self-fetch targets are exempt before `getSessionInfo` runs.

## Acceptance criteria

In a tenant past its grace period, for a member without a passkey, with a session cookie:

- `GET /api/passwords`, `GET /api/vault/status` and `PUT /api/tenant/policy`: 403
  `PASSKEY_REQUIRED` and one deduplicated blocked audit row.
- Cookie plus a junk `Authorization: Bearer x` on a bearer-eligible route: 403.
- Bearer-only (no cookie) on a bearer-eligible route: not gated here. That is `#965`'s per-use
  gate.
- Each exempt entry answers as its route does (not 403). A non-exempt method on an exempt path
  (for example `DELETE /api/webauthn/credentials/[id]`) is 403.
- `/dashboard/...`: the page proxy redirects to the passkey page, which shows the minimal screen.
  - The user registers a passkey with the vault locked.
  - The next `/api/passwords` call is allowed without waiting for the cache.
- Allowed, with no gate effect: inside the grace period, with the requirement off, or with a
  passkey (including one registered under another tenant).

## Testing strategy

- **Proxy unit:**
  - A shared session-fixture builder with explicit passkey fields. The existing proxy and
    api-route tests move to it, so they do not flip through the fail-closed bundle (TQ2).
  - C1 cells: deny/allow, grace boundary, cookie plus junk Bearer, Bearer-only, an API_DEFAULT
    route with a cookie, and an invalid session on API_DEFAULT.
  - Self-fetch cells that assert `getSessionInfo`'s fetch is not issued for the exempt targets.
    The global fetch mock is asserted per URL (TQ1).
- **Manifest table test (TQ4):** for every route in `scripts/checks/route-policy-manifest.json`,
  for each method, with a blocked session cookie, the request is either refused 403, or matched by
  a named exempt entry or own-gate route. Exempt entries must not hit vault, tenant, api-keys or
  operator-token paths (I2). A new route therefore fails until it is classified.
- **Client unit:**
  - `fetchApi` reaction: navigates once on 403 `PASSKEY_REQUIRED`, and not on other 403s.
  - The layout renders the minimal screen when blocked.
  - The card registers while locked without the PRF wrap.
- **Integration (real DB):** `webauthn/register/verify` invalidates the cache entry, and the
  proxy's next decision sees `hasPasskey`.
- **E2E (Playwright, E1):**
  - A dedicated tenant with `require_passkey` past grace, and a CDP virtual authenticator.
  - API 403; the minimal screen; registration with the vault locked; then the dashboard loads.
  - This also pins that the exempt set is complete for the real page (F17).
- **Red proofs on a scratch copy:** remove the gate; drop an exempt entry the page needs (E2E and
  the table go red); widen the exempt set onto a vault route (the table goes red); remove the
  cache invalidation.

## Considerations & constraints

- SC1: bearer credentials are `#965`.
- SC2: client presentation in the iOS app and the browser extension is `#963`.
- SC3: other sessions of the same user keep a stale `hasPasskey=false` for up to 30 s after
  registration (C2).
- Behaviour change: a blocked member's open dashboard tabs navigate to the passkey page at their
  next API call.

## User operation scenarios

- An admin enables `requirePasskey` with a 7-day grace period. After it, a passkey-less member's
  next dashboard navigation lands on the minimal screen, and any API call from an open tab sends
  them there too.
  - They register a passkey (vault locked or not) and continue to the dashboard.
  - Later, on the passkey page with the vault unlocked, they set up PRF auto-unlock.
- A blocked admin cannot change the tenant policy through the API.
- A blocked member can still sign out, revoke their other sessions, and revoke extension and MCP
  tokens.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | proxy session gate, order, exempt set, own-gate routes | pending |
| C2 | minimal recovery screen, registration while locked, fetchApi reaction, cache invalidation | pending |
| C3 | stale comments and policy doc | pending |
