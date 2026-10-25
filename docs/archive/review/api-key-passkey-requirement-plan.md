# Plan: api-key-passkey-requirement

Issue `#956` (follow-up from `#742`, PR `#957`, code review round 6, finding S-R6-2).
Revision 7. After plan review round 2 the user split the work three ways: the session-cookie
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
| iOS AutoFill mint and upload | `issueAutofillToken` behind `checkAuth` with an `IOS_APP` token; uploads with the `IOS_AUTOFILL` token | via the host token (C9 of `passkey-enforcement-token-paths-plan.md`) | covered by C5, superseding C9 (C6 removed) |
| iOS host token refresh | `refreshIosToken` (inline gate) | refresh | unchanged; C7 records the dependency |
| MCP access token | `validateMcpToken` | authorize, consent, exchange, refresh | unchanged, refresh-bound at 1 h (SC1) |
| SA, SCIM tokens, share links | — | not user-bound | C7 `exempt` |
| Bridge, mobile and MCP authorization codes (`codeHash`) | — | one-time; the minted token is gated | C7 `exempt` |
| `Session.sessionToken`, `VerificationToken.token`, `TeamInvitation.token`, `McpClient.clientSecretHash` | — | session cookie (`#959`), magic link, invitation accepted under a session, client secret compared inside the exchange | out of class: not bearer API credentials and not looked up by `tokenHash`/`codeHash` (S29) |

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
  - The write is bounded by a limiter, not by the proxy's dedup map (S18, S24): a module-level
    `createRateLimiter({ windowMs: PASSKEY_AUDIT_DEDUP_MS, max: 1 })` — without
    `failClosedOnRedisError`, so a Redis outage falls back to memory and keeps writing rows
    rather than writing none (S27) — keyed
    `` `rl:passkey_gate_audit:${blockedPath}:${credentialId}` `` (F43). One row per credential per
    window, shared across processes through Redis. The proxy's `recordPasskeyAuditEmit` map is
    not used, so the two cannot crowd each other out. Without Redis the limiter's in-memory
    fallback is per process and capped at `RATE_LIMIT_MAP_MAX_SIZE` (10 000) — beyond that,
    eviction re-emits rather than drops (F37). The refusal itself is not limited: every blocked
    request is denied, only the durable row is bounded.
  - Number of distinct keys while a user is blocked: the credentials live at the moment of
    blocking — at most 10 API keys (`MAX_API_KEYS_PER_USER`), the tenant's operator tokens, 3
    extension family rows (`CLIENT_TOKEN_MAX_ACTIVE_FAMILIES`) and 1 AutoFill row. Extension and
    AutoFill mints are gated, so those cannot churn; API keys and operator tokens are minted by
    session routes, which stay ungated on `/api/*` until `#959`, so until then the set also grows
    by the mints their create limiters allow — each of which writes its own audit row anyway
    (S23, S26).
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
  the C3 gate (`EXTENSION_TOKEN`, `token.id`) → the `lastUsedAt`/IP/UA write → one success
  return. The two DPoP branches (`IOS_APP`, and `BROWSER_EXTENSION`/`IOS_AUTOFILL`) keep their
  own failure mapping (`EXTENSION_TOKEN_INVALID` and `EXTENSION_TOKEN_DPOP_INVALID`
  respectively) but converge before the gate, so there is one gate, one write and one
  `ok: true` return (S21/F34).
- The write moves out of `validateExtensionTokenDpop` into `validateExtensionToken`, its only
  caller, so a DPoP failure or a gate refusal writes nothing, and a DPoP failure is never audited
  as blocked. It stays one object literal (`#926`); `validate-token-dpop.ts` loses its
  `withBypassRls` import and its `check-bypass-rls` `ALLOWED_USAGE` entry (F36).
- `validateIosTokenDpop` (`mobile-token.ts`) is deleted with its tests: no production caller
  (`grep -rn 'validateIosTokenDpop' src | grep -v test` lists only its definition), and it is a
  second ungated validator that marks the row used.
- `TokenValidationError` gains `"PASSKEY_REQUIRED"`.
- **Self-protection exemption** (S12/F15): `validateExtensionToken(req, { passkeyExemption:
  PASSKEY_EXEMPTION.<member> })`, the option an inline object literal and the value a member of
  the const object `PASSKEY_EXEMPTION`, defined in the leaf `extension-token-types.ts` so route
  tests that mock `extension-token` by factory keep working (N2). An exempt call skips the gate and nothing else. Members, pinned by C7:
  - `extension/token/route.ts` DELETE and `extension/key/reset/route.ts` POST — `SELF_REVOCATION`;
  - `mobile/cache-rollback-report/route.ts` POST — `TAMPER_REPORT`.
  Each returns only an acknowledgement or a count and changes nothing beyond revoking the
  caller's own rows or writing one rate-limited audit row.
- Every non-exempt caller answers 403 `API_ERROR.PASSKEY_REQUIRED`: `authOrToken` through C8, and
  the direct callers `mobile/favicon` GET, `mobile/favicon-pref` GET/PUT and
  `extension/token/refresh` POST, which today hard-code 401.
- **Refresh (F27):** the per-use gate in the validator shadows the refresh route's inline gate,
  which is therefore removed. The route still contains `extensionToken.create`, so it gets an
  entry in `scripts/checks/passkey-mint-gate-exempt.txt` — "gated per use in
  `validateExtensionToken` (C5), before the mint" — rather than a dead `passkeyEnforcementBlocks`
  call to satisfy `check-passkey-mint-gate.sh` (F31/N1). That check keeps owning "every mint
  route is gated"; C7 owns "every validator is gated per use". Outcome change, accepted: a blocked user whose family is past its
  absolute or presence limit now gets `PASSKEY_REQUIRED` instead of the family being revoked with
  `SESSION_EXPIRED`; the rows still die at `expiresAt`. Replay detection is unaffected —
  `REVOKED` is checked before the gate.
- Clients, unchanged: the extension clears its token on a 403 from refresh, as it does today for
  the refresh-time gate, so the user re-pairs after registering a passkey. iOS: E1/SC5.
- **AutoFill (F32, user decision): C9 is superseded.** The mint is reached only through
  `checkAuth` with an `IOS_APP` token, and `IOS_AUTOFILL` rows are consumed only through
  `validateExtensionToken`, so C5 refuses both the mint and the upload for a blocked user. C9
  left the mint ungated so a passkey-less user could save their first passkey with the
  passwd-sso iOS provider; that only ever lasted the host token's remaining idle window, because
  the host refresh was already gated. A blocked user registers their first passkey with another
  authenticator (the platform keychain or a security key) on the browser passkey page. A refused
  mint or upload makes the AutoFill extension cancel the system sheet before it returns a
  credential (`PasskeyRegistrationOutcome.swift`: only `.complete` returns one), so the relying
  party records nothing and no orphaned registration is left (F44). The
  `autofill-token` entry in `passkey-mint-gate-exempt.txt` gets the reason "gated per use via the
  `IOS_APP` host token in `validateExtensionToken` (C5; supersedes C9)". The file's header,
  which describes only parent-token exemptions and cites C9, is rewritten to name the three
  kinds — gated through a parent token, gated per use in the credential's validator, and gated
  inline in the mint or refresh library function (F48) — and the
  self-test fixture's superseded deadlock reason is replaced (F41).

### C6 — removed
The AutoFill mint is covered by C5. The ID is not reused.

### C7 — a static gate for the class
Revision 7 de-specifies this contract on purpose. Rounds 4–6 kept finding defects in the
previous revision's mechanism text rather than in the design, and each fix seeded the next
round's finding; a mechanism that cannot be described without being run is one to run. The
plan keeps what no toolchain decides — the class, the adjudication rules, the decisions — and
leaves fixture construction and exact AST spellings to Phase 2, where the gate's own first run
and its red proofs settle them. Phase 3 reviews the built gate.

- **Form:** a ts-morph gate `scripts/checks/check-bearer-passkey-gate.mjs` with a JSON
  manifest and a self-test `scripts/__tests__/check-bearer-passkey-gate.test.mjs` (the name
  `check-gate-selftest-coverage.sh` requires) that includes a cell passing against the real
  repo. Built after reading `check-session-token-hashed.mjs`, `check-passkey-mint-gate.sh` and
  their self-tests. Wired into `scripts/pre-pr.sh` and the static-checks CI job. The scan root,
  the schema and the manifest sit under one fixture-root override.
- **What the class is (adjudicated by the code, not a list):** a digest lookup — any delegate
  call whose argument has a `where` containing a `tokenHash` or `codeHash` key, on the models
  that declare such a column in `prisma/schema.prisma` (read through
  `lib/prisma-relation-reach.mjs`; an empty set fails). Raw SQL whose text mentions
  `token_hash`/`code_hash`, or whose SQL argument is not a literal, fails.
- **Refuse rather than guess:** on those models a `where` the gate cannot read (not an object
  literal, or containing a spread) is a decision a human makes, not one the gate infers. Such a
  function needs an `opaque-where` manifest entry with a reason and its call count, so a new
  opaque site still fails (F46/T34). The first run's list is the seed; today's known members are
  `emergency-access-state#transition` and `#bulkTransition` (the digest arrives through
  `args.where` from the accept/reject routes), `user-session-invalidation#invalidateUserSessions`,
  `user/mcp-tokens/[id]#handleDELETE`, `share-links#handleGET` and `share-links/mine#handleGET`.
- **Classes for each attributed function** (attribution: nearest named function, method or
  exported `const`; key `<repo path>#<name>`): `per-use-gated`, `refresh-bound` (names its
  refresh route, lifetime constant and any inline gate it relies on), `exempt` (a reason),
  `opaque-where` (above).
- **`per-use-gated` means**, adjudicated on the AST with scope-aware import resolution: the
  function's own body (nested blocks included, nested functions excluded) returns nothing but
  an `ok: false` object literal before one `if` that is a direct statement of the body, whose
  condition is the awaited `passkeyGateBlocks(...)` from `passkey-gate` — or a negated
  `passkeyExemption` test wrapping that `if` — and at least one return follows it (S21, S28,
  S31, F45, F47, T28, T29).
- **Exemption pin (I3):** the set of `(path#handler, member)` pairs passing
  `passkeyExemption` equals the three in C5; any way of reaching `validateExtensionToken` the
  gate cannot follow — value references, `.call`/`.apply`, named or `export *` re-exports,
  namespace or dynamic imports — fails (S22, S30, S33).
- **Forbidden reads:** `requirePasskey`/`hasPasskey` read in non-test `src/lib/auth/tokens/**`.
- **Seed for the first run** (to be confirmed by it, not a frozen list): `per-use-gated` —
  `validateApiKey`, `validateOperatorToken`, `validateExtensionToken`; `refresh-bound` —
  `validateMcpToken`, `resolveRefreshTokenGate`, `exchangeRefreshToken`,
  `mobile/token/refresh#handlePOST`; `exempt` — SA and SCIM validators, revocation-only lookups
  (`revokeToken`, `detectRefreshReplay`), one-time action tokens (admin reset, emergency access
  accept/reject), share links, and the one-time codes (bridge and mobile codes: the minted row is
  gated per use by C5; MCP codes: gated at exchange, the token refresh-bound, SC1).

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
- `POST /api/mobile/autofill-token` with an `IOS_APP` token: 403, nothing minted; `POST
  /api/passwords` with an `IOS_AUTOFILL` token: 403.

For each credential: one `PASSKEY_ENFORCEMENT_BLOCKED` row per credential (a delta) after the
first refusal and still one after a second refusal of the same credential within
`PASSKEY_AUDIT_DEDUP_MS`; a second credential
of the same kind adds a row; allowed with a passkey (including one registered under another
tenant), inside the grace period, or without the requirement; `requirePasskeyEnabledAt = NULL`
enforces immediately.

## Testing strategy

- **Integration (real DB, real validators):** one route per credential (the acceptance routes),
  plus `DELETE /api/extension/token` as the real-path exemption proof, and the two AutoFill
  cells: the mint with an `IOS_APP` row (the `cache-rollback-report-audit` insert) answers 403
  with an `IOS_AUTOFILL` row-count delta of 0, and an upload with an `IOS_AUTOFILL` row
  (`client_kind 'IOS_AUTOFILL'`, `cnf_jkt`, a fresh proof) answers 403 (T27).
  The dedup cell asserts that the second response is itself 403 `PASSKEY_REQUIRED` before it
  counts rows — a request refused before the gate (a replayed DPoP `jti`, a 429) would otherwise
  keep the count at one without the limiter — and builds each DPoP request with a fresh proof
  and `jti`. Red proof: delete the limiter check (T24).
  The file does not mock `@/lib/audit/audit` or `@/lib/security/rate-limit`, which some of the
  harnesses it borrows seeders from do; route limiters stay real, under budget because every
  test seeds fresh users and credentials (T25). Three acceptance routes use fail-closed
  limiters, which answer 503 without Redis, so `@/lib/security/rate-limit` is partially mocked
  to construct every limiter with `failClosedOnRedisError: false` — real semantics, in memory
  when Redis is absent (T31). `@/auth` returns no session, the session boundary; `checkAuth`
  and `authOrToken` are not mocked (T32). AutoFill cells assert the `PASSKEY_REQUIRED` code;
  the mint cell sends a real JWK so that, with the gate removed, it would reach the mint (T33). Grace boundary cells (deny
  at `now − (grace+1) d`, allow at `now − (grace−1) d`). Audit deltas counted in `audit_outbox`
  by `tenant_id` and `payload->>'action'`; each test seeds its own credentials, so the audit
  limiter's keys never repeat across tests.
  Existing seeders are reused: operator token (`master-key-rotation-races`), API key
  (`c13-deactivated-user-api-key`), WebAuthn credential (`reauth-credential-binding`), `IOS_APP`
  row (`cache-rollback-report-audit`), digests through the production `hashToken`. Cleanup in
  `afterEach`. I2 is proved at unit level; integration does not assert `last_used_at` (the write
  is fire-and-forget and throttled) (T21).
- **Unit — the gate and validators:**
  - `passkey-gate.test.ts` mocks prisma, `withBypassRls`, `logAuditAsync` and the rate limiter —
    `createRateLimiter` through `vi.hoisted` returning `{ check, clear }`, its construction
    options read from the first call before any mock reset, `check` re-armed in each
    `beforeEach` (T26). It pins the limiter options (`PASSKEY_AUDIT_DEDUP_MS`, `max: 1`, no
    `failClosedOnRedisError`), the grant (`PASSKEY_ENFORCEMENT_STATE`, no `tx`), the audit
    fields, the limiter key,
    that a limited refusal still returns `true` without a write, and rejection on a derivation
    error.
  - Validators mock `passkeyGateBlocks` by its own export (`importOriginal` spread). I2: the
    update spy is not called on a deny and is called on the paired allow, with `lastUsedAt: null`
    in both cells so the API-key and operator-token throttles cannot make the deny pass
    vacuously (N7) — for C5 on both client-kind branches, with the DPoP helper mocked as a whole (it no longer writes) and
    `extensionToken.update` in the prisma mock (T14).
  - C5 also: a DPoP failure with the gate mocked to block returns `EXTENSION_TOKEN_INVALID` on
    the `IOS_APP` branch and `EXTENSION_TOKEN_DPOP_INVALID` on the other, never calls the gate,
    and writes nothing — one cell per branch (N5); the IP/UA-by-clientKind assertions move from `validate-token-dpop.test.ts` to
    `extension-token.test.ts`; `validate-token-dpop.test.ts` gains a cell that the helper writes
    nothing on success (T14).
  - Exemption at validator level: with the gate mocked to block, an exempt call succeeds without
    calling the gate; an exempt call with a revoked token is still `REVOKED`; with a failing
    proof, still refused (T15).
  - Fail-closed: the helper rejects, the validator rejects with the same error, and one route per
    credential (`v1/passwords` GET, `audit-outbox-metrics` GET, `mobile/favicon` GET) rejects
    with it — `withRequestLog` rethrows, so the cell asserts `rejects.toThrow`, paired with a 200
    (T22/N4).
- **Unit — mappers and sites:**
  - `validateApiKeyOnly` 403; `validateV1Auth`: `PASSKEY_REQUIRED` → 403, no SA fall-through,
    `UNAUTHORIZED` and scope bodies unchanged; `verifyAdminToken`: `PASSKEY_REQUIRED` → 403,
    others 401 (T20).
  - Each of the seven v1 handler methods, the ten admin routes, the four non-exempt direct
    extension callers, `checkAuth` and the three C8 consumers gets a cell that asserts **status
    403 and** the body; the `openapi.json` cell sets `OPENAPI_PUBLIC=false` and pairs with an
    allow cell (T19).
  - Exempt routes: `mobile/cache-rollback-report/route.test.ts` and
    `src/__tests__/api/extension/key/reset.test.ts` assert `validateExtensionToken` was called
    with `(req, { passkeyExemption: <member> })`; `extension/token/route.test.ts` runs the real
    validator, so it mocks `passkey-gate` to block and asserts DELETE succeeds without calling the
    gate (T15/N6).
  - Refresh outcome change: with the validator refusing `PASSKEY_REQUIRED`, the route answers 403
    and calls neither `detectRefreshReplay`, the family revocation, nor `extensionToken.create`
    (N8).
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
  - `extension/token/refresh` tests, both trees (`route.test.ts` and
    `src/__tests__/api/extension/token-refresh-cnfJkt.test.ts`): the inline-gate cells are
    replaced by the refusal cell above (F40).
  - `src/app/api/passwords/route.test.ts` runs the real `authOrToken` → `validateExtensionToken`:
    it mocks `passkey-gate` file-wide (allow by default) (N2).
  - Static gates: `passkey-mint-gate-exempt.txt` gains the refresh entry and the rewritten
    AutoFill reason; `check-bypass-rls.mjs` loses the `validate-token-dpop.ts` entry (N1).
  - No integration or E2E test turns `requirePasskey` on today, so none flips.
- **C7 self-test:** one fixture per refusal and acceptance rule in C7, each red-proved
  by the gate failing on it; the real-repo cell passes. The fixture set is built in Phase 2
  from the rules, not listed here.
- **Red proofs on a scratch copy:** remove each gate; the helper returns `false`; `lastUsedAt`
  written before the gate; the write put back into the DPoP helper; an `ok: true` return
  moved above the gate; a DPoP failure audited; an
  extra exempt call site; an unlisted lookup; a shadowed `passkeyGateBlocks`.

## Considerations & constraints

- SC1: MCP access tokens stay refresh-bound at 1 h (`MCP_TOKEN_EXPIRY_SEC`), including those of
  an OAuth-logged-in CLI.
- SC2: no cache for the derived bearer state.
- SC3: the other inline issue/refresh gates (bridge code, mobile authorize, MCP, iOS refresh) are
  not migrated to C3.
- SC4: sessions on `/api/*`, the exempt page set, and open-tab UX — `#959`.
- SC5: presenting `PASSKEY_REQUIRED` promptly in the iOS host app, the iOS AutoFill extension
  (which today cancels the passkey sheet silently) and the browser extension — `#963`
  (F44).
- Documentation: `docs/security/policy-enforcement.md` — the `requirePasskey` row lists the
  per-use bearer validators beside the proxy (F22), and the extension idle/absolute rows note
  that a blocked user's refresh answers `PASSKEY_REQUIRED` before the family is revoked (F38);
  `docs/security/auth-surface-matrix.md` — the ExtensionToken, ApiKey and OperatorToken rows
  name the C3 gate, and the ExtensionToken dispatch text no longer names `validateIosTokenDpop`
  (F42).
- Behaviour change: a member without a passkey after the grace period loses API access through
  every bearer credential until they register one.

## User operation scenarios

- An admin turns on `requirePasskey` with a 7-day grace period. During it, everything works.
  After it, a passkey-less member's `passwd-sso run`/`env` with an API key and their own API
  scripts get 403 with the passkey message; operator scripts get 403; the extension's calls fail
  at once but it stays connected until its next scheduled refresh — up to the tenant idle limit
  (7 d by default, 30 d at most) — and then asks them to reconnect (F39; prompter feedback is
  SC5); an OAuth-logged-in CLI keeps working until its 1 h MCP token needs a refresh. The
  passwd-sso iOS provider cannot save a passkey for them; they use the platform keychain or a
  security key.
- They register a passkey in the browser. API keys and operator tokens work again without
  reissuing; the extension needs re-pairing if its refresh was refused meanwhile.
- A blocked user can still revoke their extension token or reset its key.

## Carried-Forward Plan Findings

Round 6 left three Majors, all resolved in revision 7 but not re-reviewed as plan prose: F46/T34
(the `opaque-where` decision) and T31 (the integration limiter mode). They are settled by
building — the C7 gate's first run against the real repo and the integration suite's allow
cells — and Phase 3 reviews the result.

- F46/T34 — Anti-Deferral: resolved by decision (`opaque-where` with reason and count), not
  deferred. Settled when the gate's real-repo cell passes with exactly the seeded opaque members
  and fails when one is removed.
- T31 — Anti-Deferral: resolved by decision (limiters constructed fail-open in the integration
  file). Settled when the allow cells on the three fail-closed-limiter routes answer 200 with and
  without `REDIS_URL`.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | API key per-use gate, `validateV1Auth` response, OpenAPI, CLI | locked |
| C2 | operator token membership + per-use gate, ten routes | locked |
| C3 | shared bearer gate helper, audit, precedence | locked |
| C5 | extension-row per-use gate, write order, exemption, refresh, AutoFill | locked |
| C7 | static class gate (rules; fixtures and spellings in Phase 2) | locked |
| C8 | `authOrToken` passkey variant and its consumers | locked |
