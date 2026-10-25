# Plan: api-key-passkey-requirement

Issue `#956` (follow-up from `#742`, PR `#957`, code review round 6, finding S-R6-2).
Revision 4. After plan review round 2 the user split the work three ways: the session-cookie
reader fix shipped as `#961`; the session gate on `/api/*` (former C4) moved to `#959`; this plan
covers the bearer credentials only. Findings are cited by ID from the review record.

## Project context

- Type: web app (Next.js 16, Prisma 7, PostgreSQL with RLS).
- Test infrastructure: unit tests, real-DB integration tests (`npm run test:integration`), CI.
- Verification environment constraints:
  - E1: the iOS app builds only on the macOS host. No iOS code changes here; the responses the
    app receives are covered by integration tests (`verifiable-CI`). How the app presents a 403
    `PASSKEY_REQUIRED` is `blocked-deferred` to SC5: its 403 handling is not uniform
    (`fetchTeamMemberKey` reads any 403 as "team key not distributed"), so the reaction is a
    client change with its own verification, not something this server change can observe (T23).
  - Everything else is `verifiable-local` and `verifiable-CI`.

## Objective

When a tenant requires a passkey (`requirePasskey`, after its grace period), a member without a
passkey must not be able to use the API through a bearer credential. Today API keys and operator
tokens are never checked, and extension-row tokens are checked only at issue and refresh, so a
token minted before the requirement keeps working for `min(idle, absolute)` — up to the tenant's
idle maximum (`EXTENSION_TOKEN_IDLE_TIMEOUT_MAX`, 30 d). Sessions on `/api/*` are `#959` (SC4).

## Member set (R42)

The class is every user-bound bearer credential that reaches a route.

| Credential | Validator | Today | This plan |
|---|---|---|---|
| API key `api_` | `validateApiKey` | never | C1, per use |
| Operator token `op_` | `validateOperatorToken` | never | C2, per use |
| Extension-row token (`BROWSER_EXTENSION`, `IOS_APP`, `IOS_AUTOFILL`) | `validateExtensionToken` | issue, refresh | C5, per use |
| iOS AutoFill mint | `issueAutofillToken`, behind `checkAuth` with an `IOS_APP` token | via the host token | covered by C5 (C6 removed) |
| iOS host token refresh | `refreshIosToken` (inline gate) | refresh | unchanged; C7 records the dependency |
| MCP access token | `validateMcpToken` | authorize, consent, exchange, refresh | unchanged, refresh-bound at 1 h (SC1) |
| SA, SCIM tokens, share links | — | not user-bound | C7 `exempt` |
| Bridge, mobile and MCP authorization codes (`codeHash`) | — | one-time; the minted token is gated | C7 `exempt` |

C7 derives the lookup set mechanically (below); the initial manifest is listed there.

## Contracts

### C1 — API keys are gated per use
- `ApiKeyValidationError` gains `"PASSKEY_REQUIRED"`. Order in `validateApiKey`: revocation,
  expiry, membership (unchanged) → the C3 gate (`API_KEY`, `key.id`) → `lastUsedAt`.
- `validateApiKeyOnly` returns status 403 for it.
- `validateV1Auth` failures carry a ready `response: NextResponse` instead of `{ error, status }`.
  `PASSKEY_REQUIRED` → 403 `API_ERROR.PASSKEY_REQUIRED`; the other failures keep today's bodies
  (`UNAUTHORIZED` 401, `API_KEY_SCOPE_INSUFFICIENT` 403); an `api_` failure never falls through to
  the SA branch. The seven v1 handler methods (passwords GET/POST, `passwords/[id]` GET/PUT/DELETE
  through its local `checkAuth`, tags GET, vault/status GET) return `authResult.response`; with
  `error`/`status` gone from the type, a hand-written mapping does not compile.
- `authOrToken` returns the C8 variant.
- OpenAPI: a v1-specific forbidden response naming `PASSKEY_REQUIRED` and the scope refusal,
  referenced by every v1 operation, including `passwords/{id}` GET/PUT/DELETE which list no 403
  today. The shared `Forbidden` is left alone: session routes use it (F25).
- CLI: `env` and `run` — the commands that call v1, when an `apiKey` is configured — read the
  body with `readApiErrorBody` on a non-OK response and, for `PASSKEY_REQUIRED`, print that the
  tenant requires a passkey to be registered in the browser. Other failures keep printing the
  HTTP status. A CLI logged in through OAuth uses MCP tokens (SC1) and is unchanged (F26).

### C2 — operator tokens are gated per use
- `validateOperatorToken` gains the tenant-scoped active-membership check `validateApiKey` has,
  before the gate, so a departed operator is refused as invalid and never audited (S4).
- `OperatorTokenValidationError` gains `"PASSKEY_REQUIRED"`; the C3 gate (`OPERATOR_TOKEN`,
  `token.id`) runs after membership and before `lastUsedAt` (F23).
- `VerifyAdminResult` failures carry `response`: `verifyAdminToken` maps `PASSKEY_REQUIRED` to
  403 `API_ERROR.PASSKEY_REQUIRED` and everything else to today's 401. The ten
  `verifyAdminToken` routes (`grep -rln 'verifyAdminToken(' src/app`) return it. The compiler
  cannot force this — the routes never read the reason — so a route left on `unauthorized()`
  still denies, with the wrong status; each route's test catches it (T20).
- The gate runs before the routes' `requireMaintenanceOperator`, so a demoted admin without a
  passkey is audited as blocked rather than as not-an-operator. Both are denials.

### C3 — one gate for bearer credentials
- New module `src/lib/auth/policy/passkey-gate.ts`, outside the proxy import graph.
- `passkeyGateBlocks({ req, userId, tenantId, credential, credentialId }): Promise<boolean>`.
  `credential` is a const object: `API_KEY`, `OPERATOR_TOKEN`, `EXTENSION_TOKEN`.
- It calls `derivePasskeyState` without a `tx`, so it opens its own
  `PASSKEY_ENFORCEMENT_STATE` bypass (the callers' `TOKEN_TENANT_MEMBERSHIP_CHECK` grant covers
  only `tenantMember`). Cost: one short read transaction per bearer request.
- On a block it awaits `logAuditAsync({ ...personalAuditBase(req, userId), tenantId,
  action: PASSKEY_ENFORCEMENT_BLOCKED, metadata: { blockedPath, credentialId } })`, where
  `tenantId` is the credential's own, so the row carries IP and user agent (S17).
  - `blockedPath` is a named constant per kind — `"api_key"`, `"operator_token"`,
    `"extension_token"` — never the request path and never starting with `/`, so it cannot
    collide with the proxy's path-keyed entries in the shared dedup map (S5, S17).
  - Dedup is per credential: the key passed to `recordPasskeyAuditEmit` is
    `` `${blockedPath}:${credentialId}` ``, so a second credential of the same kind is recorded
    (S18). Bounded: at most `MAX_API_KEYS_PER_USER` keys and `CLIENT_TOKEN_MAX_ACTIVE_FAMILIES`
    families per user, inside the map's existing cap.
  - No token or digest is recorded.
- No try/catch: a derivation error propagates and the request fails closed.
- **Precedence, stated and accepted:**
  - The gate sits in the validators, so it runs before every caller's scope and clientKind check
    and before `enforceAccessRestriction` (F24, F28, S16). A blocked user's request answers
    `PASSKEY_REQUIRED` even when its scope or network would also have refused it.
  - The cost: an off-network use of a blocked user's stolen API key or operator token is audited
    as one deduplicated `PASSKEY_ENFORCEMENT_BLOCKED` row with the request's IP, not as
    `ACCESS_DENIED` per request; and the 403 tells the holder the account lacks a passkey.
    Extension tokens are mostly unaffected because DPoP runs first.
  - Why accepted: the gate in the validator is what makes I1 structural. Running it after
    `enforceAccessRestriction` would put it back in every caller — the per-route placement this
    plan exists to remove.

### C4 — removed
Moved to `#959` (SC4). The ID is not reused.

### C5 — extension-row tokens are gated per use
- Order in `validateExtensionToken`: lookup → revoked/expired → membership → DPoP verification →
  the C3 gate (`EXTENSION_TOKEN`, `token.id`) → the `lastUsedAt`/IP/UA write, on both success
  paths (the `IOS_APP` branch and the `BROWSER_EXTENSION`/`IOS_AUTOFILL` branch).
- The write moves out of `validateExtensionTokenDpop` into `validateExtensionToken`, its only
  caller, so a DPoP failure or a gate refusal writes nothing, and a DPoP failure is never audited
  as blocked.
- `validateIosTokenDpop` (`mobile-token.ts`) is deleted with its tests: no production caller
  (`grep -rn 'validateIosTokenDpop' src | grep -v test` lists only its definition), and it is a
  second ungated validator that marks the row used.
- `TokenValidationError` gains `"PASSKEY_REQUIRED"`.
- **Self-protection exemption** (S12/F15): `validateExtensionToken(req, { passkeyExemption:
  PASSKEY_EXEMPTION.<member> })`, the option an inline object literal and the value a member of
  the const object. An exempt call skips the gate and nothing else. Members, pinned by C7:
  - `extension/token/route.ts` DELETE and `extension/key/reset/route.ts` POST — `SELF_REVOCATION`;
  - `mobile/cache-rollback-report/route.ts` POST — `TAMPER_REPORT`.
  Each returns only an acknowledgement or a count and changes nothing beyond revoking the
  caller's own rows or writing one rate-limited audit row.
- Every non-exempt caller answers 403 `API_ERROR.PASSKEY_REQUIRED`: `authOrToken` through C8, and
  the direct callers `mobile/favicon` GET, `mobile/favicon-pref` GET/PUT and
  `extension/token/refresh` POST, which today hard-code 401.
- **Refresh (F27):** the per-use gate in the validator shadows the refresh route's inline gate,
  which is therefore removed. Outcome change, accepted: a blocked user whose family is past its
  absolute or presence limit now gets `PASSKEY_REQUIRED` instead of the family being revoked with
  `SESSION_EXPIRED`; the rows still die at `expiresAt`. Replay detection is unaffected —
  `REVOKED` is checked before the gate.
- Clients, unchanged: the extension clears its token on a 403 from refresh, as it does today for
  the refresh-time gate, so the user re-pairs after registering a passkey. iOS: E1/SC5.
- The AutoFill mint is reached only through `checkAuth` with an `IOS_APP` token, so C5 refuses it
  before `issueAutofillToken` runs; `IOS_AUTOFILL` rows are consumed only through
  `validateExtensionToken`, so they are gated on use.

### C6 — removed
The AutoFill mint is covered by C5. The ID is not reused.

### C7 — a static gate for the class
- A ts-morph gate `scripts/checks/check-bearer-passkey-gate.mjs`, built after reading
  `check-session-token-hashed.mjs` and its self-test, with a JSON manifest. Self-test
  `scripts/__tests__/check-bearer-passkey-gate.test.mjs` (the name
  `check-gate-selftest-coverage.sh` requires), including a cell that passes against the real
  repo. Wired into `scripts/pre-pr.sh` and the static-checks CI job.
- **Lookups:** every `findUnique`/`findFirst`/`findUniqueOrThrow`/`findFirstOrThrow` call in
  non-test `src/**` whose `where` has a `tokenHash` or `codeHash` key — written as a property,
  shorthand, or string-literal key. A `where` that is not an object literal, or a computed key,
  fails the gate (refuse rather than guess).
- **Attribution:** the nearest enclosing named function, method or exported `const`; an anonymous
  callback attributes to its enclosing function. Manifest key: `<repo path>#<name>`.
- **Classes:** `per-use-gated` — the function calls `passkeyGateBlocks`, resolved scope-aware to
  the `passkey-gate` module (alias, namespace and relative imports accepted; a shadowing local or
  another module's export of the same name is not), and the awaited result is the condition of an
  `if` whose consequent returns; `refresh-bound` — names its refresh route, lifetime constant and,
  where it has one, the inline gate it relies on; `exempt` — a reason.
- **Exemption pin:** every `validateExtensionToken` call (import resolved scope-aware, aliases
  included) whose second argument is present must be an object literal whose `passkeyExemption`
  resolves to a `PASSKEY_EXEMPTION` member; the set of (path#handler, member) pairs must equal
  the three in C5. A variable, spread or forwarded options argument fails.
- **Forbidden reads:** `requirePasskey`/`hasPasskey` read under `src/lib/auth/tokens/**` as a
  property access, element access or destructuring.
- **Fails** on an unlisted function, a stale entry, a count that differs from the manifest size or
  is zero.
- **Initial manifest** (21 functions; derivation: the gate's own first run, cross-checked with
  `grep -rn 'tokenHash\|codeHash' src | grep -v test | grep where`):
  - `per-use-gated`: `validateApiKey`, `validateOperatorToken`, `validateExtensionToken`.
  - `refresh-bound`: `validateMcpToken` (1 h; refresh gate in `resolveRefreshTokenGate`),
    `resolveRefreshTokenGate`, `exchangeRefreshToken`, `mobile/token/refresh#handlePOST` (inline
    gate in `refreshIosToken`), `extension/token/refresh#detectRefreshReplay` (replay lookup of a
    revoked row; the refresh itself goes through `validateExtensionToken`).
  - `exempt`: `validateServiceAccountToken`, `validateScimToken` (not user-bound);
    `oauth-server#revokeToken` (revocation only); `vault/admin-reset#handlePOST`,
    `emergency-access/accept#handlePOST`, `emergency-access/reject#handlePOST` (one-time action
    tokens, not API credentials); `share-links/verify-access#handlePOST`, `s/[token]#SharePage`,
    `s/[token]/download#GET` (share links, not user-bound); `mobile/token#handlePOST`,
    `extension/token/exchange#handlePOST`, `oauth-server#resolveCodeTenantId`,
    `oauth-server#exchangeCodeForToken` (one-time codes; the minted token is gated).

### C8 — `authOrToken` reports a passkey refusal
- `AuthOrTokenResult` gains `{ type: "passkey_required" }`, returned when the API-key or
  extension-token validator says `PASSKEY_REQUIRED`.
- `checkAuth` answers 403 `API_ERROR.PASSKEY_REQUIRED`.
- The other consumers (`grep -rln 'authOrToken(' src | grep -v test`):
  - `vault/ssh/sign-authorize`, `vault/delegation/check`: the existing 403
    `reason: "unauthorized"` arm. API keys and extension tokens cannot carry their MCP scopes, so
    no legitimate client needs a distinct reason (F24).
  - `v1/openapi.json` (authenticated only when `OPENAPI_PUBLIC=false`): 403
    `API_ERROR.PASSKEY_REQUIRED`. It checks only `!result` today, so the variant would pass it
    silently without this branch (F29).
  - `tenant/access-requests`: reached only for `sa_` bearers, which cannot produce the variant;
    anything but `service_account` is already unauthorized.

## Invariants

- I1 (app-enforced, gated by C7): every user-bound bearer validator is gated per use by
  `passkeyGateBlocks`, or refresh-bound with a stated lifetime.
- I2 (app-enforced, unit-tested): a refused credential is not marked used.
- I3 (app-enforced, gated by C7): only the three C5 members skip the gate.

No schema-enforced form exists: the requirement is a function of tenant policy, time and another
table's row count.

## Acceptance criteria

In a tenant whose grace period has expired, for a member with no passkey:

- `GET /api/v1/passwords` with an API key: 403 `PASSKEY_REQUIRED`; `passwd-sso run` prints the
  passkey message.
- `GET /api/maintenance/audit-outbox-metrics` with an operator token: 403. A departed operator:
  401 and no blocked row.
- A vault API call with an extension token (through `checkAuth`): 403; `mobile/favicon`: 403;
  refresh: 403. `DELETE /api/extension/token`: succeeds.
- `POST /api/mobile/autofill-token` with an `IOS_APP` token: 403, nothing minted.

For each credential: one `PASSKEY_ENFORCEMENT_BLOCKED` row per credential (a delta) after the
first refusal and still one after a second refusal of the same credential; a second credential
of the same kind adds a row; allowed with a passkey (including one registered under another
tenant), inside the grace period, or without the requirement; `requirePasskeyEnabledAt = NULL`
enforces immediately.

## Testing strategy

- **Integration (real DB, real validators):** one route per credential (the acceptance routes),
  plus `DELETE /api/extension/token` as the real-path exemption proof. Grace boundary cells (deny
  at `now − (grace+1) d`, allow at `now − (grace−1) d`). Audit deltas counted in `audit_outbox`
  by `tenant_id` and `payload->>'action'`, with `_resetPasskeyAuditForTests()` in `beforeEach`.
  Existing seeders are reused: operator token (`master-key-rotation-races`), API key
  (`c13-deactivated-user-api-key`), WebAuthn credential (`reauth-credential-binding`), `IOS_APP`
  row (`cache-rollback-report-audit`), digests through the production `hashToken`. Cleanup in
  `afterEach`. I2 is proved at unit level; integration does not assert `last_used_at` (the write
  is fire-and-forget and throttled) (T21).
- **Unit — the gate and validators:**
  - `passkey-gate.test.ts` mocks prisma, `withBypassRls` and `logAuditAsync`; it pins the grant
    (`PASSKEY_ENFORCEMENT_STATE`, no `tx`), the audit fields, the per-credential dedup key, and
    rejection on a derivation error.
  - Validators mock `passkeyGateBlocks` by its own export (`importOriginal` spread). I2: the
    update spy is not called on a deny and is called on the paired allow — for C5 on both
    success branches, with the DPoP helper mocked as a whole (it no longer writes) and
    `extensionToken.update` in the prisma mock (T14).
  - C5 also: a DPoP failure with the gate mocked to block returns `DPOP_INVALID` and never calls
    the gate; the IP/UA-by-clientKind assertions move from `validate-token-dpop.test.ts` to
    `extension-token.test.ts`; `validate-token-dpop.test.ts` gains a cell that the helper writes
    nothing on success (T14).
  - Exemption at validator level: with the gate mocked to block, an exempt call succeeds without
    calling the gate; an exempt call with a revoked token is still `REVOKED`; with a failing
    proof, still refused (T15).
  - Fail-closed: the helper rejects, the validator rejects with the same error, and one route per
    credential (`v1/passwords` GET, `audit-outbox-metrics` GET, `mobile/favicon` GET) answers 500,
    paired with a 200 (T22).
- **Unit — mappers and sites:**
  - `validateApiKeyOnly` 403; `validateV1Auth`: `PASSKEY_REQUIRED` → 403, no SA fall-through,
    `UNAUTHORIZED` and scope bodies unchanged; `verifyAdminToken`: `PASSKEY_REQUIRED` → 403,
    others 401 (T20).
  - Each of the seven v1 handler methods, the ten admin routes, the four non-exempt direct
    extension callers, `checkAuth` and the three C8 consumers gets a cell that asserts **status
    403 and** the body; the `openapi.json` cell sets `OPENAPI_PUBLIC=false` and pairs with an
    allow cell (T19).
  - Exempt routes: the route test asserts `validateExtensionToken` was called with
    `(req, { passkeyExemption: <member> })` (T15).
  - `authOrToken`: both test trees.
  - CLI: `run` and `env` — a mocked 403 `PASSKEY_REQUIRED` prints the passkey message; a generic
    403 still prints the status. OpenAPI: every `/api/v1` operation lists 403 with the v1
    forbidden response (T16).
- **Existing tests that change (T13):**
  - `api-key.test.ts`, `operator-token.test.ts`, `extension-token.test.ts`: mock `passkey-gate`
    file-wide (allow by default); add the `tenantMember` mock to `operator-token.test.ts` and
    `extensionToken.update` to `extension-token.test.ts`.
  - `validate-token-dpop.test.ts`: the write assertions move to `extension-token.test.ts`
    (above).
  - `mobile-token.test.ts`: the `validateIosTokenDpop` cells are deleted with the function.
  - `v1-auth.test.ts`, `admin-token.test.ts`: assertions move from `{error, status}` / `reason`
    to `response`.
  - The ten admin route tests: their 401 mocks return a `response`.
  - `extension/token/refresh` tests: the inline-gate cells are replaced by validator-refusal
    cells.
  - No integration or E2E test turns `requirePasskey` on today, so none flips.
- **C7 self-test fixtures:** shorthand, string-literal and computed `tokenHash` keys; `where` as a
  variable; `OrThrow` variants; a lookup inside an anonymous callback; gate import aliased,
  namespaced, relative, shadowed and from another module; a gate call whose result is unused or
  not a returning `if`; an exemption passed as a variable, a spread, through a forwarding
  wrapper, or with the wrong member; forbidden reads as property, element access and
  destructuring; a stale manifest entry (T18, S19).
- **Red proofs on a scratch copy:** remove each gate; the helper returns `false`; `lastUsedAt`
  written before the gate; the write put back into the DPoP helper; a DPoP failure audited; an
  extra exempt call site; an unlisted lookup; a shadowed `passkeyGateBlocks`.

## Considerations & constraints

- SC1: MCP access tokens stay refresh-bound at 1 h (`MCP_TOKEN_EXPIRY_SEC`), including those of
  an OAuth-logged-in CLI.
- SC2: no cache for the derived bearer state.
- SC3: the other inline issue/refresh gates (bridge code, mobile authorize, MCP, iOS refresh) are
  not migrated to C3.
- SC4: sessions on `/api/*`, the exempt page set, and open-tab UX — `#959`.
- SC5: the iOS app presenting `PASSKEY_REQUIRED` — a follow-up issue, proposed at the end of
  Phase 1.
- Documentation: `docs/security/policy-enforcement.md` — the `requirePasskey` row lists the
  per-use bearer validators beside the proxy (F22).
- Behaviour change: a member without a passkey after the grace period loses API access through
  every bearer credential until they register one.

## User operation scenarios

- An admin turns on `requirePasskey` with a 7-day grace period. During it, everything works.
  After it, a passkey-less member's `passwd-sso run`/`env` with an API key and their own API
  scripts get 403 with the passkey message; operator scripts get 403; the extension stops working
  at the next call and asks them to reconnect at the next refresh; an OAuth-logged-in CLI keeps
  working until its 1 h MCP token needs a refresh.
- They register a passkey in the browser. API keys and operator tokens work again without
  reissuing; the extension needs re-pairing if its refresh was refused meanwhile.
- A blocked user can still revoke their extension token or reset its key.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | API key per-use gate, `validateV1Auth` response, OpenAPI, CLI | pending |
| C2 | operator token membership + per-use gate, ten routes | pending |
| C3 | shared bearer gate helper, audit, precedence | pending |
| C5 | extension-row per-use gate, write order, exemption, refresh | pending |
| C7 | static class gate and initial manifest | pending |
| C8 | `authOrToken` passkey variant and its consumers | pending |
