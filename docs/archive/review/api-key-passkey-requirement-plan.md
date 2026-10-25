# Plan: api-key-passkey-requirement

Issue `#956` (follow-up from `#742`, PR `#957`, code review round 6, finding S-R6-2).
Revision 2. The scope was widened by the user after plan review round 1 (S1/F3): sessions on API
routes and extension-row tokens are in, alongside API keys and operator tokens.

## Project context

- Type: web app (Next.js 16, Prisma 7, PostgreSQL with RLS).
- Test infrastructure: unit tests, real-DB integration tests (`npm run test:integration`), and CI.
- Verification environment constraints: none. Every path below runs locally and in CI.

## Objective

When a tenant requires a passkey (`requirePasskey`, after its grace period), a member without a
passkey must not be able to use the API, whatever they authenticate with. Today the requirement is
enforced as follows:

- page navigations: redirected by the proxy (`src/lib/proxy/page-route.ts`);
- extension, iOS and MCP tokens: checked when issued and when refreshed.

It is not enforced anywhere else:

- session-cookie requests to `/api/*`, including routes that authenticate in the handler
  (`/api/vault/*`, `/api/folders/*`);
- API keys and operator tokens, at any point, including issuance (both are minted by session-authed
  API routes);
- extension-row tokens between refreshes. The window is `min(idle, absolute)`, and the tenant can
  set the idle part up to `EXTENSION_TOKEN_IDLE_TIMEOUT_MAX` (30 d).

The `src/auth.ts` comment claiming that the proxy reads the requirement "on every request" is
corrected by this work.

## Member set (R42)

The class is every way a user-bound principal reaches `/api/*`.

- Bearer validators (defining primitive):
  `grep -rnE '^export (async )?function (validate|authenticate|verify)[A-Za-z]*(Token|Key|Session|Bearer)' src/lib`.
  C7 re-derives this set mechanically from `tokenHash` lookups.
- Session: every request carrying the Auth.js session cookie, whatever `classifyRoute` returns.
- Existing gate sites: `grep -rn 'derivePasskeyState(' src | grep -v '\.test\.'`.

| Principal | Validator / entry | Passkey checked today | This plan |
|---|---|---|---|
| Session, page navigation | proxy `page-route.ts` | every request (redirect) | unchanged |
| Session, `/api/*` | proxy, route-handler `auth()`/`checkAuth` | never | **C4**: per request in the proxy |
| API key `api_` | `validateApiKey` | never | **C1**: per use |
| Operator token `op_` | `validateOperatorToken` | never | **C2**: per use |
| Extension-row token (`BROWSER_EXTENSION`, `IOS_APP`, `IOS_AUTOFILL`) | `validateExtensionToken` | issue, refresh | **C5**: per use |
| iOS AutoFill mint | `issueAutofillToken` | never | **C6**: at issue |
| MCP access token | `validateMcpToken` | authorize, consent, code exchange, refresh | unchanged. The token lives `MCP_TOKEN_EXPIRY_SEC` = 1 h (SC1) |
| Delegation session | via the MCP token, created from a session | bounded by MCP, and by C4 at creation | unchanged |
| SA token, SCIM token, admin env token, share links | — | not user-bound | n/a |

## Contracts

### C1 — `validateApiKey` enforces the requirement per use
- `ApiKeyValidationError` gains `"PASSKEY_REQUIRED"`.
- Order of checks:
  1. revocation, expiry and active membership (unchanged);
  2. the C3 gate with `{ userId, tenantId: key.tenantId, credential: API_KEY, credentialId: key.id }`;
  3. the `lastUsedAt` update.
- Consumers:
  - `validateApiKeyOnly` returns status `API_ERROR_STATUS.PASSKEY_REQUIRED` (403) for that error.
  - `validateV1Auth` forwards the status it receives instead of hardcoding 401, and does not fall
    through to the SA branch.
  - The seven `/api/v1/*` handler sites map `PASSKEY_REQUIRED` to
    `errorResponse(API_ERROR.PASSKEY_REQUIRED)`: `v1/passwords/route.ts` (GET, POST),
    `v1/passwords/[id]/route.ts` (GET, PUT, DELETE), `v1/tags/route.ts`, `v1/vault/status/route.ts`.
    The implementation adds one shared mapper that all of them call. C7 checks that no v1 handler
    maps the auth failure by hand.
  - `authOrToken` keeps returning `null` (deny, 401).
  - `src/lib/openapi-spec.ts`: every v1 operation lists a 403 response, and the shared `Forbidden`
    description names `PASSKEY_REQUIRED`.
  - CLI (`cli/src/commands/run.ts`, `env.ts`, and any command calling v1): on a non-OK response it
    reads the body with `readApiErrorBody`. When the error is `PASSKEY_REQUIRED`, it prints that the
    tenant requires a passkey and the user must register one in the browser.

### C2 — `validateOperatorToken` enforces the requirement per use
- `validateOperatorToken` gains the active-membership check that `validateApiKey` has (C13),
  tenant-scoped to the token's tenant. This runs before the gate (S4), so a departed operator is
  refused as invalid and never audited as blocked.
- `OperatorTokenValidationError` gains `"PASSKEY_REQUIRED"`. The gate runs with
  `credential: OPERATOR_TOKEN`, after revocation, expiry and membership, and before `lastUsedAt`.
- `VerifyAdminFailReason` gains `"PASSKEY_REQUIRED"`. Consumers are the ten `verifyAdminToken`
  routes:
  - `maintenance/{purge-history, purge-audit-logs, dcr-cleanup, audit-outbox-metrics,
    audit-chain-verify, audit-outbox-purge-failed}`;
  - `admin/rotate-master-key/{initiate, [rotationId]/approve, [rotationId]/revoke,
    [rotationId]/execute}`.

  They answer 403 `API_ERROR.PASSKEY_REQUIRED` through one shared mapper. The scripts in `scripts/`
  print the body on non-200 and need no change.

### C3 — one gate for bearer credentials
- New module `src/lib/auth/policy/passkey-gate.ts`. It is not imported by the proxy graph, which
  keeps `logAuditAsync` out of the proxy. `passkey-enforcement.ts` stays proxy-safe.
- `export async function passkeyGateBlocks(args: { req: NextRequest; userId: string;
  tenantId: string; credential: PasskeyGateCredential; credentialId: string; tx?: Prisma.TransactionClient }): Promise<boolean>`.
  - `PasskeyGateCredential` is a const object: `API_KEY`, `OPERATOR_TOKEN`, `EXTENSION_TOKEN`,
    `AUTOFILL_MINT`.
  - It derives the state with `derivePasskeyState` (passing `tx` through when given) and decides
    with `passkeyEnforcementBlocks`.
  - When blocking, and when `recordPasskeyAuditEmit(userId, blockedPath, now)` allows, it **awaits**
    `logAuditAsync({ ...personalAuditBase(req, userId), tenantId, action: PASSKEY_ENFORCEMENT_BLOCKED,
    metadata: { blockedPath, credentialId } })`.
  - `blockedPath` is a constant per credential kind (`"api_key"`, `"operator_token"`,
    `"extension_token"`, `"autofill_mint"`), never the request path, so an attacker-chosen path
    segment cannot churn the dedup map (S5).
  - The id goes into the metadata. Neither the plaintext nor its hash is ever recorded.
  - No try/catch: a derivation error propagates and the request fails.

### C4 — sessions on `/api/*` are gated in the proxy
- **Where:** the proxy is the single ingress (CLAUDE.md, Proxy/Route boundary). For every `/api/*`
  request that carries a session cookie, and is not a Bearer-authenticated request, the proxy
  resolves the session through the existing `getSessionInfo`. That includes the route-handler-auth
  classes, which today skip it.
- **Decision:** when `passkeyEnforcementBlocks(sessionInfo)` is true and the path is not exempt, the
  proxy answers 403 with the JSON `API_ERROR.PASSKEY_REQUIRED` body.
- **Audit:** it emits through the proxy's existing self-fetch to `/api/internal/audit-emit`, deduped
  with `blockedPath: "api_session"`.
- **Exempt set:** an exact-match `ReadonlySet`, beside `PASSKEY_EXEMPT_PATHS`, derived from the
  requests the exempt page `/dashboard/settings/auth/passkey` and the sign-out flow make. The
  derivation command and the resulting list are recorded in the deviation log in Phase 2. At
  minimum it holds the WebAuthn registration endpoints, the passkey-status read, `/api/auth/*`,
  and the locale write.
  - Each exempt member needs a reason, and the set is pinned by a test.
  - Vault-sensitive API routes are never exempt, for the same reason the page set is narrow.
- **Unresolvable session:** a cookie that `getSessionInfo` cannot resolve keeps today's behaviour
  for that class, so the route's own auth answers 401. The gate never turns a missing session into
  an allow, because without a session there is no session principal.
- **Cost:** `getSessionInfo` already carries `requirePasskey`, `hasPasskey`,
  `requirePasskeyEnabledAt` and `passkeyGracePeriodDays`, and is cached for `SESSION_CACHE_TTL_MS`.
  The route-handler-auth classes now pay one cached session resolution.

### C5 — extension-row tokens are gated per use
- `validateExtensionToken` covers all three client kinds. It runs the C3 gate inside its existing
  membership read (`tx` passed through) after DPoP and membership, with
  `credential: EXTENSION_TOKEN` and `credentialId: token.id`.
- New error `EXTENSION_TOKEN_PASSKEY_REQUIRED`. Every caller maps it to 403
  `API_ERROR.PASSKEY_REQUIRED`:
  - `authOrToken` returns `null`;
  - the eight direct callers listed by `rtk proxy grep -rln 'validateExtensionToken(' src`;
  - the refresh route, which keeps its own issue-time gate.
- Clients: the extension and the iOS app already treat a refused refresh as a dead session. That
  each surfaces `PASSKEY_REQUIRED` usefully on a refused request is checked in Phase 2. Extend the
  handling if it does not.

### C6 — the AutoFill mint is gated
`issueAutofillToken` calls the C3 gate (`AUTOFILL_MINT`) before minting. It then follows the "gate
at every issuance" rule the other mints follow.

### C7 — a static gate for the class
- A ts-morph gate under `scripts/checks/`, following the manifest pattern of the existing
  manifest-backed AST gates.
- It enumerates every function in non-test `src/**` that performs a `findUnique`/`findFirst` keyed
  on `tokenHash`.
- Each one must be classified in a manifest as one of:
  - `per-use-gated`: the body calls `passkeyGateBlocks`, resolved scope-aware to an import from
    `@/lib/auth/policy/passkey-gate`;
  - `refresh-bound`: names its refresh route and the token's lifetime constant;
  - `not-user-bound`: gives a reason.
- An unlisted function or a stale entry fails the gate, and it prints the number of functions
  analysed, with a floor.
- It also refuses `.requirePasskey`/`.hasPasskey` property reads in `src/lib/auth/tokens/**`, which
  replaces the round-1 forbidden pattern.
- It ships with a fixture self-test and is wired into `pre-pr.sh` and CI.

## Invariants

- I1 (app-enforced, gated by C7): every user-bound bearer validator is either gated per use by
  `passkeyGateBlocks`, or refresh-bound with a stated lifetime.
- I2: a refused credential is not marked used.
- I3: every `/api/*` request authenticated by a session is gated by the C4 check, unless its path
  is in the pinned exempt set.

## Acceptance criteria

All in a tenant whose grace period has expired, for a member with no passkey:

- Session: `GET /api/passwords` with the session cookie answers 403 `PASSKEY_REQUIRED`, and so does
  a `/api/vault/*` route. An exempt WebAuthn registration call succeeds. A member with a passkey is
  allowed.
- API key: `/api/v1/passwords` and `/api/v1/passwords/[id]` answer 403 `PASSKEY_REQUIRED`, and the
  CLI prints the passkey message.
- Operator token: `GET /api/maintenance/audit-outbox-metrics` answers 403 `PASSKEY_REQUIRED`. A
  departed operator gets 401, with no blocked audit row.
- Extension token: a vault API call answers 403 `PASSKEY_REQUIRED`.
- AutoFill mint: refused with 403.

For each credential:

- one `PASSKEY_ENFORCEMENT_BLOCKED` row (a delta) on the first refusal, and still one after a
  second;
- allowed when the member has a passkey (including one registered under another tenant), inside
  the grace period, or when the tenant has no requirement;
- `requirePasskeyEnabledAt = NULL` enforces immediately.

## Testing strategy

- **Integration (real DB, real validators, no mock of the validator under test):**
  - one route per principal;
  - grace boundary cells: deny at `now − (grace+1) d`, allow at `now − (grace−1) d`;
  - audit row deltas filtered by tenant and action, with `_resetPasskeyAuditForTests()` in
    `beforeEach`;
  - local seeders for the tenant policy, a WebAuthn credential, an API key (`last_used_at` NULL),
    and an operator token with a real plaintext;
  - cleanup registered in `afterEach`.
- **Unit:**
  - Validator tests mock `passkeyGateBlocks` by its own export (`importOriginal` spread). This is
    the authoritative I2 proof: the update spy is not called on a deny and is called on the paired
    allow.
  - The helper's own test mocks prisma, `withBypassRls` and `logAuditAsync`.
  - Fail-closed: the helper rejects with a distinct error, the validator rejects with the same
    error, and the route answers 500, paired with a 200.
  - Every mapping site (7 v1, 10 admin, extension callers) gets one cell, or one test of the shared
    mapper plus C7's check that every site uses it.
  - `authOrToken`: both test trees.
- **Proxy:** C4 deny, allow and exempt cells in `src/__tests__/proxy.test.ts`. The exempt-set
  pinning test fails when the set changes without its reason list changing.
- **Red proofs on a scratch copy:**
  - remove each gate;
  - the helper returns `false`;
  - `lastUsedAt` is updated before the gate;
  - an exempt-set entry is added;
  - C7: an unlisted `tokenHash` lookup.

## Considerations & constraints

- SC1: MCP access tokens stay refresh-bound, at 1 h (`MCP_TOKEN_EXPIRY_SEC`; the max constant is
  unused at issuance). C7 records them as `refresh-bound`.
- SC2: no cache for the derived bearer state. C4 reuses the session cache.
- SC3: the seven inline issue/refresh gates are not migrated to the C3 helper. When they are, the
  mock-boundary note above applies.
- Behaviour change: a member who has not registered a passkey after the grace period loses API
  access through every principal until they do. This is what the policy says; the README's passkey
  policy text is updated to say so.

## User operation scenarios

- An admin turns on `requirePasskey` with a 7-day grace period.
  - During the grace period, everything works.
  - After it, a passkey-less member is redirected to the passkey page in the browser. Their direct
    API calls get 403, and so do their CLI, extension and iOS app.
  - They register a passkey on the exempt page. Everything works again without reissuing anything.
- A passkey-less admin cannot use `/api/tenant/policy` to turn the requirement off after the grace
  period.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | API key per-use gate and its consumers | pending |
| C2 | operator token membership + per-use gate and the ten routes | pending |
| C3 | shared bearer gate helper | pending |
| C4 | session gate for `/api/*` in the proxy, with a pinned exempt set | pending |
| C5 | extension-row token per-use gate | pending |
| C6 | AutoFill mint gate | pending |
| C7 | static class gate | pending |
