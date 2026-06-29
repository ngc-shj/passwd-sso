# Plan: Enforce requirePasskey on token-issuance paths (extension + iOS)

## Project context

- **Type**: web app / service (Next.js + Prisma). Security fix.
- **Test infra**: unit + integration + E2E + CI.
- **Verification constraints**: VC1 — the passkey ceremony itself needs a virtual
  authenticator; but this fix gates on `hasPasskey` (a boolean from a DB count) +
  grace-period math, both unit-testable without a real ceremony. `verifiable-CI`.

## Objective

Close a real policy-bypass: the tenant `requirePasskey` policy is enforced ONLY at
the web page-route layer (`src/lib/proxy/page-route.ts` ~L201-238, redirect to
passkey setup). The token-issuance choke points — extension bridge-code and iOS
mobile authorize — do NOT enforce it. A user signed into the web session before
passkey enforcement began (e.g. via Google OIDC) can, with that same session,
mint an extension token or an iOS mobile token without ever registering a passkey,
even after the grace period expires.

This is NOT an "iOS ignores policy" bug — it is a server-side enforcement gap that
affects BOTH the extension and iOS. The fix is at the choke point both pass
through, not in the clients.

## Requirements

- FR1: When `requirePasskey` is on, the user has no passkey, and the grace period
  has expired, both `/api/extension/bridge-code` and `/api/mobile/authorize` MUST
  refuse to issue a bridge code (the precursor to a token), with a distinct error
  the clients can surface ("register a passkey to continue").
- FR2: Within the grace period (not yet expired), issuance proceeds (matches the
  web page-route behavior: grace = allow-through).
- FR3: No regression to the web page-route enforcement (unchanged) or to clients
  for tenants without `requirePasskey`.
- FR4: A `PASSKEY_ENFORCEMENT_BLOCKED` audit event is emitted on a token-path block
  (same action as the web path), with metadata distinguishing the path
  (`blockedPath: "/api/extension/bridge-code"` etc.).

## Technical approach

The grace-period + exempt logic in `page-route.ts` is page-route-local. Extract the
**decision** (not the redirect) into a shared, framework-agnostic helper, then call
it from all three sites (page-route keeps its redirect; the two token routes return
their error envelopes). This is R1/R17: one helper, all call sites adopt it.

Both token routes already call `auth()`, and the Auth.js session callback
(`src/auth.ts` ~L394-422) already attaches `requirePasskey`, `hasPasskey`,
`requirePasskeyEnabledAt`, `passkeyGracePeriodDays` to the session — so **no extra
DB query is needed**; the routes read the same session fields the page-route uses.

## Contracts

### C1 — Shared passkey-enforcement decision + audit-dedup helpers
- **Module**: `src/lib/auth/policy/passkey-enforcement.ts` (NEW).
- **Signatures**:
  - `isPasskeyGracePeriodExpired(enabledAt: string | null | undefined, graceDays: number | null | undefined): boolean` — MOVED verbatim from page-route.ts (same semantics: no enabledAt → true; no/zero grace → true; else `now > enabledAt + graceDays*MS_PER_DAY`).
  - `passkeyEnforcementBlocks(p: { requirePasskey?: boolean; hasPasskey?: boolean; requirePasskeyEnabledAt?: string | null; passkeyGracePeriodDays?: number | null }): boolean` — returns true iff `requirePasskey && !hasPasskey && isPasskeyGracePeriodExpired(...)`. This is the page-route condition MINUS the path-exempt check.
  - **CALLER SHAPE (round-2 T8 — critical)**: the four passkey fields live at DIFFERENT nesting on the two caller types. The page-route has a FLATTENED `SessionInfo` with the fields at top level (`auth-gate.ts:103-106`). The `auth()`-driven token routes (C2/C3/C6) expose them at `session.user.*` (`auth.ts:441-453`, `next-auth.d.ts:10-13` augments `Session["user"]`). The helper takes the flat shape `p`; callers pass the correctly-nested object: page-route passes its `SessionInfo`, token routes pass `session.user`. A caller that passes the bare `auth()` `session` (fields undefined at top level) silently never blocks — this MUST be called out so neither the impl nor the tests read the wrong level. Add a one-line type at each call site documenting `passkeyEnforcementBlocks(session.user)`.
  - `recordPasskeyAuditEmit(userId: string, nowMs: number): boolean` — MOVED from page-route.ts (the per-user 5-min dedup that prevents audit flood, S3). Returns true if this emit should fire (not deduped). The module-private Map + `PASSKEY_AUDIT_DEDUP_MS` / `PASSKEY_AUDIT_MAP_MAX` + `_*ForTests` helpers move WITH it.
- **Scope of the move (precise — T2)**: `isPasskeyGracePeriodExpired` AND the audit-dedup machinery (`recordPasskeyAuditEmit`, the Map, the constants, the `_*ForTests`) relocate to the shared module. `page-route.ts` imports all of them; its `PASSKEY_EXEMPT_PATHS` + `isPasskeyExemptPath` stay local (page-route-specific). Update the imports in `page-route.test.ts` and `proxy.test.ts` (they import `recordPasskeyAuditEmit` / `_*ForTests` from page-route today → repoint to the shared module).
- **Invariants**:
  - app-enforced: byte-for-byte same grace math + dedup window as the current page-route (SAME functions, relocated). page-route.ts imports them (R3 propagation: remove the local definitions, import the shared ones).
- **Forbidden patterns**:
  - `pattern: function isPasskeyGracePeriodExpired` outside the new module — reason: SSoT (R3).
  - `pattern: const passkeyAuditEmitted = new Map` outside the new module — reason: the anti-suppression dedup map has exactly one home.
- **Acceptance**: page-route behavior unchanged (existing page-route + proxy tests green after repointing imports); helpers unit-tested directly.

### C2 — Enforce in extension bridge-code
- **Module**: `src/app/api/extension/bridge-code/route.ts`.
- **Placement**: after `auth()` and after the existing step-up gate
  (`requireRecentCurrentAuthMethod`, ~L189) — same neighborhood as the other
  pre-issuance gates. Use the SESSION fields (already loaded by `auth()`); do NOT
  add a DB query.
- **Behavior**: if `passkeyEnforcementBlocks(session)` → return a distinct error
  (`PASSKEY_REQUIRED`, HTTP 403) BEFORE minting the bridge code, and emit the
  `PASSKEY_ENFORCEMENT_BLOCKED` audit (C4).
- **Consumer-flow walkthrough**:
  - Consumer: extension SW `startConnect` (path: extension/src/background/token-handler.ts) reads the bridge-code response; on non-ok it extracts `errorCode`. `extractErrorCode` currently only propagates `SESSION_STEP_UP_REQUIRED`; it must also recognize the new `PASSKEY_REQUIRED` so the web-app connect UI can show a "register a passkey" message. → C5 (client surfacing) is in scope for the extension; otherwise the user sees a generic failure.
- **Acceptance**: requirePasskey + no passkey + grace expired → 403 PASSKEY_REQUIRED, no bridge code minted, audit emitted. Within grace → bridge code minted.

### C3 — Enforce in iOS mobile authorize
- **Module**: `src/app/api/mobile/authorize/route.ts`.
- **Placement**: after `auth()` + `requireRecentSession` (~L120), before creating
  the `mobileBridgeCode` row.
- **Behavior**: if `passkeyEnforcementBlocks(session)` → refuse by redirecting to the
  **fixed** iOS callback scheme with `error=passkey_required` appended
  (`passwd-sso://auth/callback?error=passkey_required`), mirroring the existing
  success-redirect shape (authorize/route.ts ~L203-205), with `Cache-Control:
  no-store`, BEFORE `mobileBridgeCode.create`. **Decision (round-1 S5 > F1)**: use
  the error-to-fixed-scheme form, NOT a redirect into the web dashboard — the
  ASWebAuthenticationSession holds the live cookie, and redirecting it into
  `/dashboard/...` re-enters the cookie'd context from the ephemeral session
  (larger surface) and muddies the "this flow mints nothing" guarantee. The fixed
  scheme is already open-redirect-safe (client redirect_uri ignored, F15). Emit the
  audit (C4).
- **Consumer-flow walkthrough**:
  - Consumer: iOS `AuthCoordinator` (path: ios/PasswdSSOApp/Auth/AuthCoordinator.swift) handles the ASWebAuthenticationSession callback; on `error=passkey_required` it must show "register a passkey in the web app first" rather than a generic auth failure. → iOS surfacing is SC-deferred (see SC1) unless trivial; the SERVER refusal is the security boundary and is in scope regardless.
- **Acceptance**: requirePasskey + no passkey + grace expired → authorize refused with passkey_required, no bridge code; within grace → proceeds.

### C4 — Audit on token-path block (deduped)
- **Module**: all gated routes (C2/C3/C6).
- **Behavior**: gate the emit through the shared `recordPasskeyAuditEmit(userId,
  now)` (C1) so client retry loops don't flood the audit (S3); when it returns
  true, emit `AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED` (the SAME action the
  page-route uses — already registered in the action group + i18n, no R12 gap) with
  `metadata: { blockedPath: <route path> }` via `logAuditAsync`.
- **Emit cardinality (T6)**: the block path emits **ONLY** `PASSKEY_ENFORCEMENT_BLOCKED`
  — NOT also the route's `*_ISSUE_FAILURE`. Tests assert exactly one emit of this
  action; do NOT reuse the existing `expectFailureEmit` helper (which expects the
  ISSUE_FAILURE action).
- **Invariants**: app-enforced — reuse the existing action constant; reuse the
  shared dedup. Do NOT mint a new audit action (R12).
- **Acceptance**: a block produces one deduped audit row with the action + path; a
  retry within the dedup window does not emit a second row.

### C6 — Enforce in MCP OAuth authorize (round-1 S1 — the missed choke point)
- **Modules**: `src/app/api/mcp/authorize/route.ts` (GET) + `src/app/api/mcp/authorize/consent/route.ts` (POST).
- **Placement**:
  - GET (~after auth()+requireRecentSession ~L69, before redirect to the consent page ~L97-104) — early-reject for clean UX.
  - POST consent (~after auth()+requireRecentSession ~L35, before `createAuthorizationCode` ~L238) — the **authoritative** boundary: a client can POST consent directly without the GET, so this MUST be gated even though the GET is.
- **Behavior** (per-route error shape — round-2 F6, the two routes differ):
  - **POST consent (authoritative)**: mirror the existing `deny` action
    (`consent/route.ts:82-93`) — 302 to the **validated** `redirect_uri` with
    `error=access_denied` + `error_description=passkey_required`. This is a concrete
    existing shape, not novel.
  - **GET authorize (UX early-reject)**: the GET has NO error-redirect-to-`redirect_uri`
    precedent (it returns `NextResponse.json({error}, {status:400})` for its OAuth
    errors). Return a JSON early-reject consistent with its OWN convention, OR redirect
    to the passkey-setup page — do NOT force the POST's redirect-with-error shape onto
    the GET ("mirror" was imprecise; disambiguate per route).
  - Read passkey state from `session.user` (T8 nesting). Emit the C4 audit with the
    per-route `blockedPath`. No authorization code minted.
- **Consent server-component page note (F7)**: `app/[locale]/mcp/authorize/page.tsx`
  renders the consent form but mints NOTHING (`createAuthorizationCode` is only in the
  POST). The GET+POST gate is the security boundary; the page needs no gate for
  correctness. Optional: a page-level early-reject for UX parity (a user reaching the
  page via a bookmarked URL otherwise sees the form, clicks Allow, and is refused only
  at the POST).
- **Invariants**: app-enforced — the POST gate is the security boundary (GET gate is
  UX); reconstruct nothing from client input; read passkey state from `session.user.*`.
- **Why this matters**: MCP tokens carry `passwords:read` / `vault`-class scopes for
  AI agents — the highest-value token class. Leaving this ungated makes the whole
  fix theater (round-1 S1, Critical).
- **Consumer-flow walkthrough**: MCP clients (DCR-registered) consume the OAuth
  error per RFC 6749 §4.1.2.1 — they read `error` from the redirect query and surface
  it. `passkey_required` is a custom code; if a stricter standard code is required,
  use `access_denied` + `error_description: "passkey_required"`. Confirm against the
  route's existing error returns.
- **Acceptance**: requirePasskey + no passkey + grace expired → consent POST refuses,
  no authorization code; within grace → proceeds; GET refuses before showing consent.

### C8 — Enforce on the REFRESH grant (round-2 S8 — the 4th bypass class)
- **Modules**: `src/app/api/extension/token/refresh/route.ts`,
  `src/app/api/mobile/token/refresh/route.ts`,
  `src/app/api/mcp/token/route.ts` (refresh grant → `exchangeRefreshToken` in
  `src/lib/mcp/oauth-server.ts`).
- **Why this is in scope (corrects SC2)**: SC2 scoped out the exchange routes
  because they "consume a code already gated upstream." That rationale is TRUE for
  the authorization_code grant but **FALSE for the refresh grant** — refresh re-mints
  a fresh token from a PRIOR token, never re-touching the gated authorize path. Today
  the web session is re-evaluated on every navigation (page-route reads live passkey
  fields per request) but tokens are NEVER re-evaluated on refresh. So a non-passkey
  user who connected once (before enforcement, or during grace) keeps refreshing
  **after** the policy turns on: MCP **forever** (no absolute cap — see below),
  extension up to 30 d, iOS up to 7 d. C6 gates NEW MCP connections but is useless for
  ALREADY-connected agents → without C8 the headline fix is theater for existing tokens.
- **Behavior**: before re-minting, evaluate `passkeyEnforcementBlocks(...)`; if blocked,
  refuse the refresh (revoke/abort, do not rotate) + emit the C4 audit.
  - Extension refresh already confirms a live session row exists — read the same tenant
    passkey fields (or call `auth()` for the session user) and gate before
    `extensionToken.create`.
  - iOS + MCP refresh are COOKIELESS (DPoP bearer, no `auth()`), so re-derive
    `requirePasskey` / `hasPasskey` / grace from the token's `tenantId` + `userId`
    (the same data the Auth.js callback computes: tenant policy row + a passkey-credential
    count). SA-bound MCP tokens (`userId === null`) SKIP the check (no human passkey
    applies — mirror the existing C13 deactivated-user skip in `oauth-server.ts`).
- **MCP absolute family cap (new)**: MCP refresh has NO absolute family cap today
  (verified: no `familyCreatedAt`/absolute check in `oauth-server.ts`), so even with
  re-gating, add an absolute cap mirroring the extension/iOS pattern so a long chain
  converges and a transiently-passkey'd-then-removed user can't refresh unbounded.
- **Invariants**: app-enforced — refresh routes FAIL CLOSED to the policy (currently
  they fail open: never consult it). Read passkey state from server-trusted sources
  (session.user for ext; DB re-derivation for cookieless iOS/MCP), never the request.
- **Acceptance**: a non-passkey user (grace expired) whose token already exists is
  refused at the next refresh on all three clients; a passkey'd user refreshes normally;
  SA-bound MCP token refreshes normally; MCP refresh chain stops at the absolute cap.

### C7 — CI guard: no ungated mint route (initial OR refresh)
- **Module**: a static check (shell grep) added to the repo's guard suite, mirroring
  `scripts/checks/check-permanent-delete-stepup.sh` + its allowlist
  `scripts/checks/stepup-delete-exempt.txt` + a **mandatory** self-test
  `scripts/__tests__/check-*.test.mjs` (round-2 T11 — the repo has ~16 such self-tests;
  the negative case — a tampered route fixture with the check removed must exit 1 — is
  the guard's whole point; "run in pre-pr" alone does NOT prove the guard fails when it
  should).
- **Behavior**: enumerate routes matching the FULL token-producing primitive set —
  initial mint (`createAuthorizationCode|extensionBridgeCode\.create|mobileBridgeCode\.create`)
  AND refresh re-mint (`exchangeRefreshToken|refreshIosToken|createRefreshToken|extensionToken\.create`)
  (round-2 S9 — the original grep was blind to refresh). Do NOT gate on `await auth()`:
  the cookieless iOS/MCP refresh routes have no `auth()`, so triggering on it would
  exclude exactly the C8 routes. Trigger on the mint/re-mint primitive alone. Assert
  each matched route calls `passkeyEnforcementBlocks` OR is on the allowlist with a
  one-line residual-risk reason.
- **Acceptance**: removing the C2/C3/C6/C8 check from any gated route fails the guard;
  a new mint OR refresh route without the check fails the guard; the self-test's
  negative fixture exits 1.

### C5 — Extension client surfacing (errorCode propagation)
- **Module**: extension/src/background/token-handler.ts (`extractErrorCode`) +
  the web connect UI (src/components/extension/auto-extension-connect.tsx) + the
  shared error-code module (src/lib/extension-connect-request.ts).
- **Behavior**: propagate `PASSKEY_REQUIRED` like `SESSION_STEP_UP_REQUIRED`; show a
  "register a passkey to connect the extension" card (new i18n keys, en + ja).
- **Source edits (round-2 F5/T9 — load-bearing, do NOT miss)**:
  - Add `PASSKEY_REQUIRED` to the `EXTENSION_CONNECT_ERROR_CODE` const (3 members today).
  - Add the `PASSKEY_REQUIRED` branch to the module-private `coerceErrorCode` allowlist
    (it currently passes only `SESSION_STEP_UP_REQUIRED` / `EXTENSION_ABSENT`; unknown →
    `GENERIC_FAILURE`, so without this the new code is silently swallowed).
  - **`export` `coerceErrorCode`** (it is module-private today) so it can be unit-tested
    directly (T9) — the repo's `_*ForTests` convention sanctions test-only exports; the
    component test mocks `requestExtensionConnect` wholesale and CANNOT exercise this seam.
- **Acceptance**: extension connect against a passkey-required tenant (no passkey,
  grace expired) shows the passkey-required message, not a generic failure.

## Invariants summary (R42 — member-set derivation, CODE-DERIVED)

"Every token-issuance choke point that requires an authenticated web session MUST
enforce requirePasskey." Member-set derived from the MINT PRIMITIVE, not a
hand-picked route list (round-1 review S1 caught a missed path this way):

```
grep -rlE 'createAuthorizationCode|extensionBridgeCode\.create|mobileBridgeCode\.create' src/app/api
```

→ three session-gated mint precursors (verified round 1):

| Route | Mint primitive | session-gated | Verdict |
|-------|----------------|---------------|---------|
| `extension/bridge-code/route.ts` | `extensionBridgeCode.create` | `auth()` | **GATE (C2)** |
| `mobile/authorize/route.ts` | `mobileBridgeCode.create` | `auth()` | **GATE (C3)** |
| `mcp/authorize/consent/route.ts` | `createAuthorizationCode` (~L238) | `auth()` | **GATE (C6 — authoritative)** |
| `mcp/authorize/route.ts` (GET) | (redirects to consent) | `auth()` | **GATE (C6 — UX early-reject)** |

Admin-role-gated mint routes (out of scope, different trust class — the admin is
role-gated via `requireTenantPermission`, a separate threat from "any signed-in
user mints their own client token"; classify, do not silently omit):
`tenant/service-accounts/[id]/tokens`, `tenant/operator-tokens`,
`tenant/scim-tokens`. SC4 tracks the decision to scope these out.

Exchange routes' **authorization_code grant** (`token/exchange`, `mobile/token`,
`mcp/token` with a fresh bridge/auth code) is cookieless/PKCE+DPoP and consumes a
code already gated upstream — intentionally NOT gated (SC2). **But the REFRESH
grant on those same routes re-mints from a prior token without re-touching the
gated authorize path** — it is a SEPARATE token-producing primitive and IS gated
(C8, round-2 S8). The C7 guard's primitive set therefore includes the refresh
re-minters, not just the initial minters.

**CI guard (C7)**: a grep-based check asserting every route matching the
mint-primitive grep AND `await auth()` either calls `passkeyEnforcementBlocks` or
is on an explicit allowlist with a reason — so the next mint route cannot silently
reopen the bypass. Mirrors the repo's existing step-up/no-store static guards.

## Forbidden patterns (diff-wide)

- `pattern: function isPasskeyGracePeriodExpired` outside the new shared module — reason: SSoT (C1).
- New audit action literal for this block — reason: reuse `PASSKEY_ENFORCEMENT_BLOCKED` (C4).

## Testing strategy

**Mock prerequisite (T1/T8, R19 — do FIRST, get the NESTING right)**: the four
passkey fields live at **`session.user.*`** for the `auth()`-driven routes (NOT
top-level — round-2 T8). So:
- `src/__tests__/helpers/mock-auth.ts` `MockSession` → add the 4 fields **inside
  `user`**, not top-level. Used by `bridge-code/route.test.ts` only.
- `mobile/authorize/route.test.ts` and `mcp/authorize/consent/route.test.ts` use
  **file-local inline `{ user: { id } }` literals** — extending `MockSession` does
  NOTHING for them; extend each inline literal at `user.*` per truth-table test.
- The page-route caller passes its FLATTENED `SessionInfo` (fields top-level); its
  tests already exist — verify they still pass the flat shape.
Without the correct nesting the gate reads `undefined` → never blocks → block tests
pass VACUOUSLY (the exact round-1/round-2 failure). **Add a non-vacuity assertion per
route**: the `on+nopasskey+graceexpired` case actually blocks AND the `off` case still
mints — if both pass with fields at the wrong level, the test is decorative.
Mock-alignment sites: (1) `mock-auth.ts` MockSession.user, (2) bridge-code overrides,
(3) mobile/authorize inline literal, (4) mcp/consent inline literal, (5)
auto-extension-connect.test.tsx `EXTENSION_CONNECT_ERROR_CODE` literal (+`PASSKEY_REQUIRED`),
(6) the three refresh-route tests (C8).

- **C1** → NEW `src/lib/auth/policy/passkey-enforcement.test.ts`: grace math
  (no enabledAt → true, zero grace → true, within → false, expired → true);
  `passkeyEnforcementBlocks` truth table; `recordPasskeyAuditEmit` dedup window.
- **C2** → extend `bridge-code/route.test.ts`. Matrix: off→minted; on+haspasskey→minted;
  on+nopasskey+withingrace→minted (FR2); on+nopasskey+graceexpired→403 PASSKEY_REQUIRED
  + no bridge code + audit; **enabledAt=null→immediate 403** (F4). Assert audit emits
  ONLY `PASSKEY_ENFORCEMENT_BLOCKED` once (T6 — do not reuse `expectFailureEmit`).
- **C3** → extend `mobile/authorize/route.test.ts`. Same matrix; assert the specific
  refusal signal (302 to `passwd-sso://auth/callback?error=passkey_required`) AND
  `mobileBridgeCode.create` NOT called AND audit (T5 — assert the signal, not just
  "no row").
- **C4** → assert action + `metadata.blockedPath` + dedup (a 2nd attempt within the
  window emits no 2nd row) in the C2/C3/C6 tests.
- **C5** → (a) direct unit test on the now-`export`ed `coerceErrorCode`
  (`coerceErrorCode("PASSKEY_REQUIRED")===PASSKEY_REQUIRED`, T9 — it is module-private
  today, MUST be exported; the component test mocks `requestExtensionConnect` wholesale
  and cannot reach this seam); (b) `auto-extension-connect.test.tsx` branch shows the
  passkey card; (c) token-handler `extractErrorCode` passes `PASSKEY_REQUIRED`; (d)
  Extension.json en/ja parity (guarded).
- **C6** → extend existing `mcp/authorize/consent/route.test.ts` + `mcp/authorize/route.test.ts`
  (both exist): same matrix; consent POST refuses pre-`createAuthorizationCode`;
  direct-POST (no GET) still gated; GET early-rejects per its JSON convention.
- **C8 (refresh)** → extend `extension/token/refresh/route.test.ts`,
  `mobile/token/refresh/route.test.ts`, and the MCP refresh test: non-passkey +
  grace-expired token → refresh refused, NOT rotated, audit emitted; passkey'd → rotates;
  SA-bound MCP (`userId===null`) → rotates (skip); MCP chain stops at the new absolute cap.
- **C4 dedup** → assert a 2nd attempt within the window emits no 2nd row; every route
  test asserting this MUST call `_resetPasskeyAuditForTests()` in `beforeEach` (T10 —
  imported from the shared module per C1) and use distinct userIds.
- **C7** → MANDATORY fixture self-test (T11): exit 0 on the real tree, exit 1 on a
  tampered fixture (gated route with the check removed), exit 0 when that route is on
  the allowlist. Mirror `scripts/__tests__/check-permanent-delete-stepup.test.mjs`.
- **page-route / proxy** → existing tests stay green after repointing the
  `recordPasskeyAuditEmit` / `_*ForTests` imports to the shared module (C1, T2).

## Considerations & constraints

### Scope contract
- **SC1 — iOS client UX for passkey_required**: the iOS `AuthCoordinator` showing a
  friendly "register a passkey first" message is deferred unless trivial; the SERVER
  refusal (C3) is the security boundary and is in scope. Owner: iOS follow-up.
- **SC2 — exchange routes (token/exchange, mobile/token)**: intentionally NOT gated
  here; they consume a bridge code that already passed C2/C3. Gating them too would
  be redundant. Owner: documented in the R42 member-set.
- **SC3 — session-callback enforcement (kill the session globally)**: rejected —
  deadlock risk (user can't reach the passkey-setup page) + UX collision with the
  existing web redirect. The choke-point approach (C2/C3/C6) is the chosen design.
- **SC4 — admin-role-gated mint routes** (`tenant/service-accounts/[id]/tokens`,
  `tenant/operator-tokens`, `tenant/scim-tokens`): NOT gated here. Different trust
  class — the admin is role-gated (`requireTenantPermission`) + step-up'd; "should an
  admin minting a machine credential also need their own passkey" is a separate policy
  question. Owner: future issue if tenants want admin-passkey on machine-credential mint.

### Known risks
- The session fields come from the Auth.js callback's tenant fetch; confirm they are
  populated for the user whose session is driving the request (they are — same session
  the page-route reads).
- **Live-session invariant (F3)**: the gated routes MUST read passkey state from the
  live `auth()` call, NEVER from a cached session snapshot (e.g. the proxy's
  `getSessionInfo` cache) — a cached snapshot would lag grace-expiry transitions by the
  cache TTL, reopening the window. All gated routes use `auth()` directly today; keep it.
- Grace-period semantics must match the web exactly (C1 reuses the same function).

## User operation scenarios

1. Tenant turns on requirePasskey with a 7-day grace; a Google-OIDC user with no
   passkey connects the extension on day 3 → allowed (within grace). On day 10 →
   refused with PASSKEY_REQUIRED; the connect card says "register a passkey".
2. Same user opens the iOS app on day 10 → authorize refused with passkey_required.
3. User registers a passkey → `hasPasskey` true → both paths proceed.
4. Tenant without requirePasskey → no change anywhere.

## Go/No-Go Gate

| ID | Subject                                              | Status  |
|----|------------------------------------------------------|---------|
| C1 | Shared decision + audit-dedup helpers                | locked  |
| C2 | Enforce in extension bridge-code                     | locked  |
| C3 | Enforce in iOS mobile authorize (error=passkey_required) | locked |
| C4 | Audit on token-path block (deduped, single-action)   | locked  |
| C5 | Extension client surfacing of PASSKEY_REQUIRED       | locked  |
| C6 | Enforce in MCP OAuth authorize GET + consent POST    | locked  |
| C7 | CI guard: no ungated mint route (initial + refresh)  | locked  |
| C8 | Enforce on the refresh grant (ext/iOS/MCP) + MCP abs cap | locked  |
