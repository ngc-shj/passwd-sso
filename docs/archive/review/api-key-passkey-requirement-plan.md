# Plan: api-key-passkey-requirement

Issue `#956` (follow-up from `#742`, PR `#957`, code review round 6, finding S-R6-2).
Revision 3. After plan review round 2 the user split the work three ways: the session-cookie
reader fix shipped as `#961`; the session gate on `/api/*` (former C4) moved to `#959`; this plan
covers the bearer credentials only. Findings are cited by ID from the review record.

## Project context

- Type: web app (Next.js 16, Prisma 7, PostgreSQL with RLS).
- Test infrastructure: unit tests, real-DB integration tests (`npm run test:integration`), CI.
- Verification environment constraints:
  - E1: the iOS app builds only on the macOS host (see the iOS build reference). No iOS code
    changes here; the server responses the app receives are covered by integration tests
    (`verifiable-CI`). The app's reaction to a 403 on a non-refresh call is `blocked-deferred`:
    it is the reaction it already has to any 403, and building the app to observe it buys nothing
    the server-side test does not.
  - Everything else is `verifiable-local` and `verifiable-CI`.

## Objective

When a tenant requires a passkey (`requirePasskey`, after its grace period), a member without a
passkey must not be able to use the API through a bearer credential. Today API keys and operator
tokens are never checked, and extension-row tokens are checked only at issue and refresh, so a
token minted before the requirement keeps working for `min(idle, absolute)` — up to the tenant's
idle maximum (`EXTENSION_TOKEN_IDLE_TIMEOUT_MAX`, 30 d).

Sessions on `/api/*` are out of scope (SC4, `#959`).

## Member set (R42)

The class is every user-bound bearer credential that reaches a route.

- Defining primitive: a lookup by token digest, `findUnique`/`findFirst` whose `where` has a
  `tokenHash` key. Derivation today: `grep -rn "tokenHash" src | grep -v test | grep -E "where"`.
  C7 re-derives it with ts-morph on every run, including multi-line, shorthand and renamed-key
  spellings the grep misses.
- Existing issue/refresh gates: `grep -rn 'derivePasskeyState(' src | grep -v '\.test\.'`.

| Credential | Validator | Today | This plan |
|---|---|---|---|
| API key `api_` | `validateApiKey` | never | C1, per use |
| Operator token `op_` | `validateOperatorToken` | never | C2, per use |
| Extension-row token (`BROWSER_EXTENSION`, `IOS_APP`, `IOS_AUTOFILL`) | `validateExtensionToken` | issue, refresh | C5, per use |
| iOS AutoFill mint | `issueAutofillToken`, behind `checkAuth` with an `IOS_APP` token | via the host token's issue/refresh | covered by C5 on the host token (C6 removed, TQ7/F18) |
| MCP access token | `validateMcpToken` | authorize, consent, exchange, refresh | unchanged, refresh-bound at 1 h (SC1) |
| SA, SCIM, admin env token, share links, one-time codes | — | not user-bound bearers | classified `exempt` in C7 with a reason (S15) |

## Contracts

### C1 — API keys are gated per use
- `ApiKeyValidationError` gains `"PASSKEY_REQUIRED"`. Order in `validateApiKey`: revocation,
  expiry, membership (unchanged) → the C3 gate (`API_KEY`, `key.id`) → the `lastUsedAt` update.
- `validateApiKeyOnly` answers status 403 for it.
- `validateV1Auth` failures carry a ready `response: NextResponse` instead of `{ error, status }`;
  `PASSKEY_REQUIRED` gives 403 `API_ERROR.PASSKEY_REQUIRED` and never falls through to the SA
  branch. The v1 handlers return `authResult.response` (F1/TQ8): with `error`/`status` gone from
  the type, a hand-written mapping no longer compiles — the type system is the adjudicator.
- `authOrToken` returns the C8 variant.
- OpenAPI: every v1 operation lists 403, and the shared `Forbidden` description names
  `PASSKEY_REQUIRED` (F7).
- CLI: commands calling v1 read the body with `readApiErrorBody` on a non-OK response and, for
  `PASSKEY_REQUIRED`, print that the tenant requires a passkey to be registered in the browser (F2).

### C2 — operator tokens are gated per use
- `validateOperatorToken` gains the tenant-scoped active-membership check `validateApiKey` has,
  before the gate, so a departed operator is refused as invalid and never audited as blocked (S4).
- Then the C3 gate (`OPERATOR_TOKEN`, `token.id`), then `lastUsedAt`.
- `VerifyAdminResult` failures carry `response`; `PASSKEY_REQUIRED` gives 403. The ten
  `verifyAdminToken` routes (`grep -rln 'verifyAdminToken(' src/app`) return it instead of
  `unauthorized()`. Unlike C1 the compiler cannot force this — the routes never read the reason —
  so each route's test gets a 403 cell (T1). A route left on `unauthorized()` still denies.
- The gate runs before the routes' `requireMaintenanceOperator`, so a demoted admin without a
  passkey is audited as blocked rather than as not-an-operator ([Adjacent] on C2). Both are
  denials; the audit row is accurate about which check fired first.

### C3 — one gate for bearer credentials
- New module `src/lib/auth/policy/passkey-gate.ts`, outside the proxy import graph (F5).
- `passkeyGateBlocks({ req, userId, tenantId, credential, credentialId }): Promise<boolean>`.
  `credential` is a const object: `API_KEY`, `OPERATOR_TOKEN`, `EXTENSION_TOKEN`.
- It calls `derivePasskeyState` **without** a `tx`, in its own `PASSKEY_ENFORCEMENT_STATE` bypass
  (F14: the callers' `TOKEN_TENANT_MEMBERSHIP_CHECK` grant covers only `tenantMember`). Cost: one
  extra short read transaction per bearer request (F8).
- Blocking: when `recordPasskeyAuditEmit(userId, blockedPath, now)` allows, it **awaits**
  `logAuditAsync` with `PASSKEY_ENFORCEMENT_BLOCKED`, `metadata: { blockedPath, credentialId }`.
  `blockedPath` is a constant per credential kind, never the request path (S5). No token or
  digest is recorded.
- No try/catch: a derivation error propagates and the request fails closed.

### C4 — removed
Moved to `#959` (SC4). The ID is not reused.

### C5 — extension-row tokens are gated per use
- Order in `validateExtensionToken`: lookup → revoked/expired → membership → DPoP verification →
  the C3 gate (`EXTENSION_TOKEN`, `token.id`) → the `lastUsedAt`/IP/UA write (S11/F14).
- The write moves out of `validateExtensionTokenDpop` into `validateExtensionToken`, its only
  caller, so a DPoP failure or a gate refusal writes nothing. A DPoP failure is never audited as
  blocked.
- `validateIosTokenDpop` (`mobile-token.ts`) is deleted with its tests. No production code calls
  it (`grep -rn 'validateIosTokenDpop' src | grep -v test` lists only its definition), and it is
  a second, ungated DPoP validator that also marks the row used — a member of the class waiting
  for a caller.
- `TokenValidationError` gains `"PASSKEY_REQUIRED"`.
- **Self-protection exemption** (S12/F15): `validateExtensionToken(req, { passkeyExemption })`,
  where `passkeyExemption` is a const object value — `SELF_REVOCATION` or `TAMPER_REPORT`. An
  exempt call skips the gate and nothing else. The members, pinned by C7:
  - `DELETE /api/extension/token` and `POST /api/extension/key/reset` (`SELF_REVOCATION`): a
    blocked user must still be able to revoke;
  - `POST /api/mobile/cache-rollback-report` (`TAMPER_REPORT`): a tamper signal must not be lost.
- Every non-exempt caller answers 403 `API_ERROR.PASSKEY_REQUIRED` (TQ5): `authOrToken` through
  C8, and the direct callers `mobile/favicon`, `mobile/favicon-pref` (GET, PUT) and
  `extension/token/refresh` (`grep -rn 'validateExtensionToken(' src/app`). Refresh still detects
  replay on `REVOKED`, which is checked before the gate.
- Clients, unchanged: the extension clears its token on a 403 from refresh, as it does today for
  the refresh-time gate, so the user re-pairs after registering a passkey; other calls fail as
  they do on any 403. iOS: E1.
- The AutoFill mint is reached only through `checkAuth` with an `IOS_APP` token, so C5 refuses it
  before `issueAutofillToken` runs.

### C6 — removed
The AutoFill mint is covered by C5 (TQ7/F18). The ID is not reused.

### C7 — a static gate for the class
- A ts-morph gate under `scripts/checks/`, modelled on `check-session-token-hashed.mjs` and its
  self-test (read first), with a manifest.
- It finds every `findUnique`/`findFirst` call in non-test `src/**` whose `where` object has a
  `tokenHash` key (literal, shorthand, or `tokenHash: <expr>`), and attributes it to the nearest
  enclosing named function, method or exported `const` — an anonymous `withBypassRls` callback
  attributes to its enclosing function.
- Each attributed function is classified in the manifest as `per-use-gated` (its body calls
  `passkeyGateBlocks`, resolved scope-aware to the `passkey-gate` import), `refresh-bound` (names
  its refresh route and lifetime constant), or `exempt` (a reason).
- It also pins the `passkeyExemption` call sites to the three C5 members, and refuses
  `.requirePasskey`/`.hasPasskey` property reads under `src/lib/auth/tokens/**`.
- Fails on an unlisted function, a stale entry, a gate call that resolves to anything but the
  real import, or an analysed count that differs from the manifest size or is zero.
- Self-test fixtures: shorthand key, aliased and namespace imports, a shadowed local of the same
  name, another module exporting the same name, an unused result, an unlisted exempt call.
- Wired into `scripts/pre-pr.sh` and the static-checks CI job.

### C8 — `authOrToken` reports a passkey refusal
- `AuthOrTokenResult` gains `{ type: "passkey_required" }`, returned when the API-key or
  extension-token validator says `PASSKEY_REQUIRED` (F13).
- `checkAuth` answers 403 `API_ERROR.PASSKEY_REQUIRED` for it.
- The other consumers (`grep -rln 'authOrToken(' src | grep -v test`) handle it explicitly:
  `vault/ssh/sign-authorize` and `vault/delegation/check` answer 403 with
  `reason: "passkey_required"` in their own shape; `v1/openapi.json` denies it; the SA-only path
  in `tenant/access-requests` cannot receive it and treats it as unauthorized.
  `v1/openapi.json` checks only `!result`, so the new variant would pass it silently — the
  reason each consumer needs a cell.

## Invariants

- I1 (app-enforced, gated by C7): every user-bound bearer validator is gated per use by
  `passkeyGateBlocks`, or refresh-bound with a stated lifetime.
- I2 (app-enforced, unit-tested): a refused credential is not marked used.
- I3 (app-enforced, gated by C7): only the three C5 members skip the gate.

No schema-enforced form exists: the requirement is a function of tenant policy, time and another
table's row count.

## Acceptance criteria

In a tenant whose grace period has expired, for a member with no passkey:

- `GET /api/v1/passwords` with an API key: 403 `PASSKEY_REQUIRED`; the CLI prints the passkey
  message.
- `GET /api/maintenance/audit-outbox-metrics` with an operator token: 403. A departed operator:
  401 and no blocked audit row.
- A vault API call with an extension token (through `checkAuth`): 403; `favicon`: 403;
  refresh: 403. `DELETE /api/extension/token` succeeds.
- `POST /api/mobile/autofill-token` with an `IOS_APP` token: 403, and nothing is minted.

For each credential: one `PASSKEY_ENFORCEMENT_BLOCKED` row (a delta) after the first refusal and
still one after a second; allowed with a passkey (including one registered under another
tenant), inside the grace period, or without the requirement; `requirePasskeyEnabledAt = NULL`
enforces immediately.

## Testing strategy

- **Integration (real DB, real validators):** one route per credential; grace boundary cells
  (deny at `now − (grace+1) d`, allow at `now − (grace−1) d`); audit deltas filtered by tenant and
  action with `_resetPasskeyAuditForTests()` in `beforeEach`; local seeders (tenant policy,
  WebAuthn credential, API key with `last_used_at` NULL, operator token with a real plaintext);
  cleanup in `afterEach`.
- **Unit:**
  - Validators mock `passkeyGateBlocks` by its own export (`importOriginal` spread). I2: the
    update spy is not called on a deny and is called on the paired allow. For C5 this needs the
    DPoP verification mocked below the write, not the whole helper (TQ6).
  - The helper's own test mocks prisma, `withBypassRls` and `logAuditAsync`.
  - Fail-closed: the helper rejects, the validator rejects with the same error, the route
    answers 500, paired with a 200.
  - One cell per mapping site: the ten admin routes, the v1 handlers, the four non-exempt direct
    extension callers, the four C8 consumers and `checkAuth`; one allow cell per exempt member.
  - `authOrToken`: both test trees.
- **Red proofs on a scratch copy:** remove each gate; the helper returns `false`; `lastUsedAt`
  written before the gate; DPoP failure audited; an extra exempt call site; an unlisted
  `tokenHash` lookup; a shadowed `passkeyGateBlocks`.

## Considerations & constraints

- SC1: MCP access tokens stay refresh-bound at 1 h (`MCP_TOKEN_EXPIRY_SEC`). C7 records them.
- SC2: no cache for the derived bearer state.
- SC3: the existing inline issue/refresh gates are not migrated to C3.
- SC4: sessions on `/api/*`, the exempt page set, and open-tab UX — `#959`.
- Behaviour change: a member without a passkey after the grace period loses API access through
  every bearer credential until they register one. The README's passkey-policy text says so.

## User operation scenarios

- An admin turns on `requirePasskey` with a 7-day grace period. During it, everything works.
  After it, a passkey-less member's CLI and API-key scripts get 403 with the passkey message,
  their extension stops working at the next call and asks them to reconnect at the next refresh,
  and operator scripts get 403.
- They register a passkey in the browser. API keys and operator tokens work again without
  reissuing; the extension needs re-pairing if its refresh was refused meanwhile.
- A blocked user can still revoke their extension token or reset its key.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | API key per-use gate, `validateV1Auth` response, OpenAPI, CLI | pending |
| C2 | operator token membership + per-use gate, ten routes | pending |
| C3 | shared bearer gate helper | pending |
| C5 | extension-row per-use gate, write order, self-protection exemption | pending |
| C7 | static class gate | pending |
| C8 | `authOrToken` passkey variant and its consumers | pending |
