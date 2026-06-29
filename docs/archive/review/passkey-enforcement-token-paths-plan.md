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

### C1 — Shared passkey-enforcement decision + DB re-derivation + audit-dedup helpers
- **Module**: `src/lib/auth/policy/passkey-enforcement.ts` (NEW).
- **Signatures**:
  - `isPasskeyGracePeriodExpired(enabledAt: string | null | undefined, graceDays: number | null | undefined): boolean` — MOVED verbatim from page-route.ts (same semantics: no enabledAt → true; no/zero grace → true; else `now > enabledAt + graceDays*MS_PER_DAY`).
  - `passkeyEnforcementBlocks(p: { requirePasskey?: boolean; hasPasskey?: boolean; requirePasskeyEnabledAt?: string | null; passkeyGracePeriodDays?: number | null }): boolean` — returns true iff `requirePasskey && !hasPasskey && isPasskeyGracePeriodExpired(...)`. This is the page-route condition MINUS the path-exempt check. The page-route keeps calling it with its flattened `SessionInfo` (`auth-gate.ts:103-106`).
  - **`derivePasskeyState(params: { userId: string; tenantId: string; tx?: PrismaTxClient }): Promise<{ requirePasskey: boolean; hasPasskey: boolean; requirePasskeyEnabledAt: string | null; passkeyGracePeriodDays: number | null }>`** (NEW — round-3 F12/F11/S15) — the single, shared DB re-derivation that every TOKEN-ISSUANCE gate uses (both the cookie'd initial-mint routes C2/C3/C6 AND the cookieless refresh routes C8). Encapsulates the recipe verified at `auth.ts:401-423`:
    - `hasPasskey` = `webAuthnCredential.count({ where: { userId } }) > 0` — **counted by `userId` ONLY** (passkeys are user-global, NOT tenant-scoped — matching `auth.ts:402`; do NOT add `tenantId` to the count, S15 corrected).
    - tenant policy (`requirePasskey`, `requirePasskeyEnabledAt`, `passkeyGracePeriodDays`) read from `tenant.findUnique({ where: { id: tenantId } })` for the **given `tenantId`** (the token-row's tenantId for refresh; the session's active tenantId for initial mint) — enforces the policy of the tenant the credential operates in (S15 fix for multi-tenant users).
    - `requirePasskeyEnabledAt` converted via `.toISOString()` (Prisma returns `Date | null`; the helper output is `string | null` so it feeds `isPasskeyGracePeriodExpired` directly — F11).
    - **RLS context (round-4 F17/F20)**: when a `tx` is passed (the caller already holds a `withBypassRls` transaction — the cookieless refresh routes), `derivePasskeyState` uses that `tx` and does NOT open a new bypass (avoids the forbidden nested-transaction in `oauth-server.ts:348-353`). When NO `tx` is passed (the cookie'd initial-mint routes C2/C3/C6), it opens its own `withBypassRls(prisma, ..., BYPASS_PURPOSE.AUTH_FLOW)` like `auth.ts:400/418`. The MCP refresh caller MUST wrap its refresh-token-row pre-read AND the `derivePasskeyState(tx)` call in one `withBypassRls(..., BYPASS_PURPOSE.TOKEN_LIFECYCLE)` — a bare `prisma.mcpRefreshToken.findUnique` outside bypass is RLS-filtered and returns null (F17).
    - **FAIL-CLOSED (S13)**: this helper does **NOT** catch DB errors. It throws on failure; every caller treats a throw as fail-closed (refuse issuance / refuse refresh — no token), NEVER fail-open. This is the deliberate divergence from the `auth.ts` session-callback catch (which fails OPEN for session-establishment availability — see Known risks).
  - `recordPasskeyAuditEmit(userId: string, blockedPath: string, nowMs: number): boolean` — MOVED from page-route.ts AND **signature changed (round-3 S14)**: the dedup key is now `${userId}:${blockedPath}` (was `userId` alone). With 4+ gated paths, per-`userId`-only dedup suppressed a real multi-path block as a single audit row (OWASP A09 under-reporting). Keying by user+path lets each path's first block within the window emit independently. The module-private Map + `PASSKEY_AUDIT_DEDUP_MS` / `PASSKEY_AUDIT_MAP_MAX` + `_*ForTests` helpers move WITH it. Update the page-route call site to pass its `pathWithoutLocale` as `blockedPath`.
  - **Test-probe helpers must track the composite key (round-4 T19)**: `_passkeyAuditHasForTests` and `_passkeyAuditFirstKeyForTests` currently key on bare `userId` (`page-route.ts:77-88`). After the key change they MUST operate on the `${userId}:${blockedPath}` composite — update `_passkeyAuditHasForTests(userId, blockedPath)` to probe the composite key, and repoint every caller in `proxy.test.ts` (`:1200-1233` — the eviction-order assertions reference bare `"u0"`/`"u2"` keys today and would silently pass vacuously otherwise). `_resetPasskeyAuditForTests` (`.clear()`) is unchanged.
- **Design note — unified re-derivation (round-3 S13/T8)**: the token-issuance gates do NOT read the four passkey fields off `session.user.*`. They call `derivePasskeyState(...)` for a FRESH, fail-closed, live read and pass the result to `passkeyEnforcementBlocks(...)`. This (a) makes every gate fail-closed regardless of the `auth.ts` session-callback fail-open (S13), (b) guarantees the live-state invariant F3 structurally (no cached snapshot), and (c) eliminates the round-2 T8 `session.user.*`-nesting trap entirely — there is no session-field nesting to get wrong because the gates re-derive. Only the web page-route continues to read its flattened `SessionInfo` fields (unchanged).
- **Scope of the move (precise — T2)**: `isPasskeyGracePeriodExpired` AND the audit-dedup machinery (`recordPasskeyAuditEmit`, the Map, the constants, the `_*ForTests`) relocate to the shared module. `page-route.ts` imports all of them; its `PASSKEY_EXEMPT_PATHS` + `isPasskeyExemptPath` stay local (page-route-specific). Update the imports in `page-route.test.ts` and `proxy.test.ts` (they import `recordPasskeyAuditEmit` / `_*ForTests` from page-route today → repoint to the shared module) AND update the `recordPasskeyAuditEmit` call (new `blockedPath` arg) in page-route + its tests.
- **Invariants**:
  - app-enforced: byte-for-byte same grace math as the current page-route (SAME `isPasskeyGracePeriodExpired`, relocated). page-route.ts imports it (R3 propagation: remove the local definitions, import the shared ones).
  - app-enforced: `derivePasskeyState` is the SSoT for token-path passkey state; the count is `userId`-scoped, the policy is `tenantId`-scoped, errors fail closed.
- **Forbidden patterns**:
  - `pattern: function isPasskeyGracePeriodExpired` outside the new module — reason: SSoT (R3).
  - `pattern: const passkeyAuditEmitted = new Map` outside the new module — reason: the anti-suppression dedup map has exactly one home.
  - `pattern: webAuthnCredential\.count` inside any `src/app/api/(extension|mobile|mcp)/**` route — reason: the count belongs in `derivePasskeyState`, not re-implemented per route (R1/R17).
- **Acceptance**: page-route behavior unchanged (existing page-route + proxy tests green after repointing imports + the `blockedPath` arg); `passkeyEnforcementBlocks` + `isPasskeyGracePeriodExpired` + `recordPasskeyAuditEmit` (new key) + `derivePasskeyState` (count-by-userId, policy-by-tenantId, toISOString, throws-on-error) unit-tested directly.

### C2 — Enforce in extension bridge-code
- **Module**: `src/app/api/extension/bridge-code/route.ts`.
- **Placement**: after `auth()` and after the existing step-up gate
  (`requireRecentCurrentAuthMethod`, ~L189) and after the route's existing tenant resolution
  — same neighborhood as the other pre-issuance gates.
- **Behavior** (round-3 S13 — re-derive; round-4 F15 — `tenantId` is NOT on `session.user`):
  `userId` comes from `session.user.id`; **`tenantId` comes from the route's EXISTING
  DB-resolved value, NOT the session** (`session.user` carries no `tenantId` — `next-auth.d.ts`).
  In bridge-code this is the `userRecord.tenantId` the route already reads via
  `withUserTenantRls`/`prisma.user.findUnique` (~L155-160), AFTER its null check. Then call
  `derivePasskeyState({ userId, tenantId })` (C1) for a fresh fail-closed read; if
  `passkeyEnforcementBlocks(state)` → return a distinct error (`PASSKEY_REQUIRED`, HTTP 403)
  BEFORE minting the bridge code, and emit the `PASSKEY_ENFORCEMENT_BLOCKED` audit (C4). A
  throw from `derivePasskeyState` (DB error) fails closed: do NOT mint (surface a 503/500, not
  a silent allow).
- **Consumer-flow walkthrough**:
  - Consumer: extension SW `startConnect` (path: extension/src/background/token-handler.ts) reads the bridge-code response; on non-ok it extracts `errorCode`. `extractErrorCode` currently only propagates `SESSION_STEP_UP_REQUIRED`; it must also recognize the new `PASSKEY_REQUIRED` so the web-app connect UI can show a "register a passkey" message. → C5 (client surfacing) is in scope for the extension; otherwise the user sees a generic failure.
- **Acceptance**: requirePasskey + no passkey + grace expired → 403 PASSKEY_REQUIRED, no bridge code minted, audit emitted. Within grace → bridge code minted. DB error during re-derivation → fail closed (no bridge code).

### C3 — Enforce in iOS mobile authorize
- **Module**: `src/app/api/mobile/authorize/route.ts`.
- **Placement**: after `auth()` + `requireRecentSession` (~L120), before creating
  the `mobileBridgeCode` row.
- **Behavior** (round-3 S13 — re-derive; round-4 F15 — `tenantId` not on session): `userId` from `session.user.id`; `tenantId` from the route's EXISTING `withUserTenantRls(userId, async (tid) => tid)` resolution (~L169), NOT the session. Call `derivePasskeyState({ userId, tenantId })` (C1, fail-closed); if `passkeyEnforcementBlocks(state)` → refuse by redirecting to the
  **fixed** iOS callback scheme with `error=passkey_required` appended
  (`passwd-sso://auth/callback?error=passkey_required`), mirroring the existing
  success-redirect shape (authorize/route.ts ~L203-205), with `Cache-Control:
  no-store`, BEFORE `mobileBridgeCode.create`. A `derivePasskeyState` throw fails closed (refuse, do not create the bridge code). **Decision (round-1 S5 > F1)**: use
  the error-to-fixed-scheme form, NOT a redirect into the web dashboard — the
  ASWebAuthenticationSession holds the live cookie, and redirecting it into
  `/dashboard/...` re-enters the cookie'd context from the ephemeral session
  (larger surface) and muddies the "this flow mints nothing" guarantee. The fixed
  scheme is already open-redirect-safe (client redirect_uri ignored, F15). Emit the
  audit (C4).
- **Consumer-flow walkthrough**:
  - Consumer: iOS `AuthCoordinator` (path: ios/PasswdSSOApp/Auth/AuthCoordinator.swift) handles the ASWebAuthenticationSession callback; on `error=passkey_required` it must show "register a passkey in the web app first" rather than a generic auth failure. → iOS surfacing is SC-deferred (see SC1) unless trivial; the SERVER refusal is the security boundary and is in scope regardless.
- **Acceptance**: requirePasskey + no passkey + grace expired → authorize refused with passkey_required, no bridge code; within grace → proceeds.

### C4 — Audit on token-path block (deduped per user+path)
- **Module**: all gated routes (C2/C3/C6/C8).
- **Behavior**: gate the emit through the shared `recordPasskeyAuditEmit(userId,
  blockedPath, now)` (C1 — **dedup key is now `${userId}:${blockedPath}`**, round-3 S14)
  so client retry loops on a single path don't flood the audit (S3), WHILE a user
  blocked across MULTIPLE paths within the window still produces one row PER PATH
  (no cross-path suppression — OWASP A09 fidelity). When it returns true, emit
  `AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED` (the SAME action the page-route uses —
  already registered in the action group + i18n, no R12 gap) with
  `metadata: { blockedPath: <route path> }` via `logAuditAsync`.
- **Emit cardinality (T6)**: the block path emits **ONLY** `PASSKEY_ENFORCEMENT_BLOCKED`
  — NOT also the route's `*_ISSUE_FAILURE`. Tests assert exactly one emit of this
  action; do NOT reuse the existing `expectFailureEmit` helper (which expects the
  ISSUE_FAILURE action).
- **Invariants**: app-enforced — reuse the existing action constant; reuse the
  shared dedup. Do NOT mint a new audit action (R12).
- **Acceptance**: a block produces one deduped audit row with the action + path; a
  retry on the SAME path within the dedup window does not emit a second row; a block
  on a DIFFERENT path for the same user within the window DOES emit (per-path key).

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
  - Read passkey state via `derivePasskeyState({ userId, tenantId })` (round-3 S13 —
    fail-closed; NOT `session.user.*`). `userId` from `session.user.id`. **`tenantId` source
    differs by route (round-4 F15/F19)**: the consent POST already resolves it via
    `prisma.user.findUnique({ select: { tenantId } })` inside `withBypassRls` (~L70-76) — reuse
    that. The GET authorize route does NOT resolve `tenantId` today — it MUST add a
    `user.findUnique({ where: { id: session.user.id }, select: { tenantId: true } })` (inside
    `withBypassRls`) before the gate (a new DB read this route did not previously make). Emit the
    C4 audit with the per-route `blockedPath`. No authorization code minted. A
    `derivePasskeyState` throw fails closed (refuse).
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

### C8 — Enforce on the REFRESH grant (round-2 S8 — the 4th bypass class) + MCP token-lifetime parity
- **Modules**: `src/app/api/extension/token/refresh/route.ts`,
  `src/app/api/mobile/token/refresh/route.ts`,
  `src/app/api/mcp/token/route.ts` (refresh grant → `exchangeRefreshToken` in
  `src/lib/mcp/oauth-server.ts`); plus, for the MCP family cap:
  `prisma/schema.prisma` (+ a migration) and `src/lib/constants/auth/mcp.ts`.
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
- **ALL THREE refresh routes are COOKIELESS (round-3 verified)**: `extension/token/refresh`
  uses `validateExtensionToken(req)` (Bearer, NO `auth()` — the round-2 "has a session"
  premise was WRONG); iOS + MCP refresh are DPoP bearer. So all three re-derive passkey
  state from the **token row's `tenantId` + `userId`** via the shared
  `derivePasskeyState({ userId, tenantId, tx })` helper (C1) — NOT `session.user`, NOT a
  per-route re-implementation.
- **Gate LAYER = the ROUTE for all three (round-3 F9/F14/T14)**: place the
  `passkeyEnforcementBlocks(derivePasskeyState(...))` check in the `route.ts` (not in the
  `refreshIosToken` / `exchangeRefreshToken` lib functions), so the C7 route-file grep
  finds `passkeyEnforcementBlocks` alongside the mint primitive. For MCP this means the
  route pre-reads the refresh-token row (tenantId/userId) before calling
  `exchangeRefreshToken`; the Phase-1 CAS inside `exchangeRefreshToken` still detects any
  concurrent rotation, so the extra read is not a TOCTOU on the rotation itself.
- **Behavior**: before re-minting, call `derivePasskeyState({ userId, tenantId: <token-row tenantId>, tx })`
  then `passkeyEnforcementBlocks(state)`; if blocked, refuse the refresh (abort, do NOT
  rotate, do NOT issue) + emit the C4 audit (`blockedPath` per route). A `derivePasskeyState`
  throw fails closed (refuse — never rotate on a DB error).
  - **Tenant source = the tenant the REFRESHED token will be BOUND TO** (round-4 F16 correction
    of S15): gate on the tenantId used to create the new token, so the policy matches the
    token's destination tenant (no bypass — a user switching to a non-passkey tenant gets a
    token scoped to that tenant; they cannot mint a passkey-tenant token without a passkey).
  - Extension refresh: gate in `extension/token/refresh/route.ts` before `extensionToken.create`
    (~L126), using **`activeSession.tenantId`** (the value the route ALREADY uses for the TTL
    policy read ~L80 and the new-token `create` ~L103/L129 — the extension token follows the
    user's active tenant on refresh). NOTE: the token row's `tenantId` (`route.ts:43`) may differ
    for a multi-tenant user; the route's existing active-tenant rebind is intentional, so the
    gate matches it (F16). (This corrects the earlier S15 wording, which assumed the token-row
    tenantId — correct for iOS/MCP, but NOT for extension which rebinds.)
  - iOS refresh: gate in `mobile/token/refresh/route.ts` after the C13 member check (~L163),
    before the `refreshIosToken` call (~L215), using the **token row's `tenantId`** (cookieless,
    no active-session rebind).
  - MCP refresh: gate in `mcp/token/route.ts` (refresh_token branch, ~L140-171) before
    `exchangeRefreshToken`, using the **refresh-token row's `tenantId`**. The route MUST wrap its
    refresh-token-row pre-read AND the `derivePasskeyState(tx)` call in one
    `withBypassRls(prisma, ..., BYPASS_PURPOSE.TOKEN_LIFECYCLE)` — a bare
    `prisma.mcpRefreshToken.findUnique` is RLS-filtered and returns null, which would fail the
    gate closed for ALL refreshes (round-4 F17). SA-bound MCP tokens (`rt.userId === null`) SKIP
    the passkey check (no human passkey applies — mirror the existing C13 `rt.userId !== null`
    skip in `oauth-server.ts:393-398`); TypeScript then narrows `userId` to `string` for the
    `derivePasskeyState` call. The pre-read provides `userId`/`tenantId` for this decision.
- **MCP absolute family cap (new — framed as MCP token-lifetime PARITY, round-3 S12/F8/F10)**:
  MCP refresh has NO absolute family cap today (`McpRefreshToken` has no `familyCreatedAt`
  column; only `ExtensionToken` does, `schema.prisma:215-217`). This is a real pre-existing
  gap independent of passkey enforcement — MCP refresh tokens can live forever via rotation
  while ext (30 d) / iOS (7 d) cannot. Bring MCP to parity:
  - **Schema migration — TWO steps, mirror the `ExtensionToken.familyCreatedAt` precedent
    (round-4 S17)**: do NOT ship a single `NOT NULL @default(now())` migration — that stamps
    existing rows with the migration time, so a >30 d family that refreshes between ADD COLUMN
    and the backfill would be wrongly treated as new (cap not enforced for that rotation).
    Follow `20260418042050` + `20260418144000`:
    1. Migration 1: `ALTER TABLE mcp_refresh_tokens ADD COLUMN family_created_at TIMESTAMPTZ(3) NULL` + inline backfill `UPDATE mcp_refresh_tokens SET family_created_at = sub.min_created FROM (SELECT family_id, MIN(created_at) min_created FROM mcp_refresh_tokens GROUP BY family_id) sub WHERE mcp_refresh_tokens.family_id = sub.family_id`.
    2. Migration 2: defensive backfill `WHERE family_created_at IS NULL` then `ALTER COLUMN family_created_at SET NOT NULL, SET DEFAULT NOW()`.
    Prisma schema ends at `familyCreatedAt DateTime @default(now()) @map("family_created_at") @db.Timestamptz(3)`. Propagate it in `createRefreshToken` (initial issue) and carry it forward unchanged across rotation in `exchangeRefreshToken`'s new-row `create` (`oauth-server.ts:440`); add it to the `findUnique` select (`oauth-server.ts:357-361`) AND to the existing `oauth-server.test.ts` C13 fixtures (`baseRt`) so they keep type-checking (round-4 T13). Run on the dev DB before PR (`feedback_run_migration_on_dev_db`).
  - **Cap constant**: `MCP_REFRESH_TOKEN_FAMILY_ABSOLUTE_TIMEOUT_SEC` in `src/lib/constants/auth/mcp.ts`, **computed from `SEC_PER_DAY`** (`feedback_time_constants_computed`), value `30 * SEC_PER_DAY` (matches the extension default; document the choice).
  - **Cap LAYER = inside `exchangeRefreshToken` (lib), NOT the route (round-4 T18)**: the cap needs
    `familyCreatedAt` from the row `exchangeRefreshToken` already `findUnique`s — put the check
    there (`now - familyCreatedAt > cap → refuse, do not rotate`; an already-over-cap family is
    refused immediately — acceptable/intended). This is a DIFFERENT layer from the passkey gate
    (which is in the route): the passkey gate + passkey-SA-skip are route-level (tested in
    `mcp/token/route.test.ts`), the absolute cap + the existing C13 deactivated-user skip are
    lib-level (tested in `oauth-server.test.ts`).
  - **Injectable clock (test seam, T13)**: add `now?: () => number` to `exchangeRefreshToken` (mirror `refreshIosToken`'s `now` param, `mobile-token.ts:449`) so the cap test is deterministic without `vi.useFakeTimers`.
- **Invariants**: app-enforced — refresh routes FAIL CLOSED to the policy (currently they
  fail open: never consult it). Passkey state comes from `derivePasskeyState` (server-trusted
  DB re-derivation keyed on the token row's `tenantId`/`userId`), never the request. The MCP
  family cap is enforced from `familyCreatedAt` (server-set at family birth), never client input.
- **Acceptance**: a non-passkey user (grace expired) whose token already exists is refused at
  the next refresh on all three clients (NOT rotated — assert the mint primitive was not
  called, T15/RT8); a passkey'd user refreshes normally; SA-bound MCP token (`userId===null`)
  refreshes normally; an MCP refresh family older than the absolute cap is refused (chain
  converges); a DB error during re-derivation fails closed (no rotation).

### C7 — CI guard: no ungated mint route (initial OR refresh)
- **Module**: a static check (shell grep) `scripts/checks/check-passkey-mint-gate.sh` added
  to the repo's guard suite, mirroring `scripts/checks/check-permanent-delete-stepup.sh` +
  an allowlist `scripts/checks/passkey-mint-gate-exempt.txt` + a **mandatory** self-test
  `scripts/__tests__/check-passkey-mint-gate.test.mjs` (round-2 T11 — the repo has ~16 such
  self-tests; the negative case — a tampered route fixture with the check removed must exit 1
  — is the guard's whole point; "run in pre-pr" alone does NOT prove the guard fails when it
  should).
- **Scan scope = `route.ts` files under `src/app/api`** — the C8 gate-layer decision (route,
  not lib) keeps this scope sufficient (F9/F14/T14): every mint/re-mint primitive's
  `passkeyEnforcementBlocks` lives in the route file, so the guard never needs to scan
  `src/lib`. (A lib-level gate would have forced lib scanning or spurious allowlisting — the
  route-level rule avoids both.)
- **Behavior**: enumerate routes matching the FULL token-producing primitive set —
  initial mint (`createAuthorizationCode|extensionBridgeCode\.create|mobileBridgeCode\.create|issueAutofillToken`)
  AND refresh re-mint (`exchangeRefreshToken|refreshIosToken|extensionToken\.create`)
  (round-2 S9 — original grep was blind to refresh; round-3 F13 — `createRefreshToken`
  REMOVED from the refresh set: it is an INITIAL-issue primitive in the authorization_code
  branch, not a re-mint; the actual MCP rotation is `exchangeRefreshToken`; round-3 S11 —
  `issueAutofillToken` ADDED so the autofill mint route is enumerated, not silently missed).
  Do NOT gate on `await auth()`: the cookieless iOS/MCP/extension refresh + autofill routes
  have no `auth()`, so triggering on it would exclude exactly the C8/autofill routes. Trigger
  on the mint/re-mint primitive alone. Assert each matched route calls `passkeyEnforcementBlocks`
  OR is on the allowlist with a one-line residual-risk reason.
- **Allowlist (round-3 S11)**: `mobile/autofill-token/route.ts` is on the allowlist with the
  reason "transitively gated via the IOS_APP host token (C3 mint + C8 refresh); a direct
  hasPasskey gate deadlocks first-passkey-save — see C9". This makes the exemption auditable
  rather than a silent member-set omission (R42).
- **pre-pr wiring (round-3 T16/RT7-b)**: add `run_step "Static: passkey-mint-gate" bash
  scripts/checks/check-passkey-mint-gate.sh` to `scripts/pre-pr.sh` (after the existing
  `permanent-delete-stepup` line ~L165) — an authored-but-unwired check runs nowhere.
- **Acceptance**: removing the C2/C3/C6/C8 check from any gated route fails the guard; a new
  mint OR refresh route without the check fails the guard; the self-test exits 0 on the real
  tree, exit 1 on a tampered MINT-route fixture, exit 1 on a tampered REFRESH-route fixture
  (round-3 T14 — both fixture types required), exit 0 when the tampered route is on the
  allowlist.

### C9 — Classify `mobile/autofill-token` as transitively-protected-exempt (round-3 S11)
- **Module**: `src/app/api/mobile/autofill-token/route.ts` (NO code change to the route's
  gate logic) + the C7 allowlist + a documentation note.
- **Finding**: `issueAutofillToken` (`mobile-token.ts:262` `tx.extensionToken.create`,
  `IOS_AUTOFILL` kind, `passwords:write`) is a 5th token-mint primitive the round-1/2
  member-set missed (it is reached via the `issueAutofillToken` lib wrapper, invisible to a
  route-file grep of `extensionToken.create` — R42 clause ③).
- **Decision: EXEMPT from a direct `hasPasskey` gate** (verified, round-3 iOS-flow trace):
  - The route already requires `clientKind === "IOS_APP"` (`route.ts:63`). The IOS_APP host
    token is passkey-gated at C3 (initial mint) and C8 (refresh), so a non-passkey user
    post-grace cannot obtain or refresh a host token → the autofill-token becomes unreachable
    once the host token's idle window (~24 h) lapses. The route is **transitively protected**.
  - A DIRECT `hasPasskey` gate here would **deadlock first-passkey-save**: the iOS AutoFill
    extension's passkey-registration ceremony requires a live `IOS_AUTOFILL` upload token to
    persist the new PASSKEY entry (`CredentialProviderViewController.swift:369-399`;
    `PasskeyRegistrationOutcome.swift:36` `guard hasUploadToken`). Blocking the mint on
    `!hasPasskey` would prevent exactly the users the policy targets from saving passkeys —
    the same registration-loop hazard the page-route's `PASSKEY_EXEMPT_PATHS` exists to avoid.
- **What C9 DOES**: (a) add `mobile/autofill-token/route.ts` to the C7 allowlist with the
  residual-risk reason; (b) document the residual exposure (a non-passkey user holding a
  still-valid host token can mint `passwords:write` autofill tokens for ≤ the host idle window
  after grace expiry — bounded, because C8 stops the host refresh); (c) NO `passkeyEnforcementBlocks`
  call in the route. This is the explicit classification R42 demands — not a silent omission.
- **Acceptance**: the C7 guard does not fire on `mobile/autofill-token` (it is allowlisted with
  a reason); the residual-risk note is recorded; no behavior change to the autofill mint.

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

"Every token-issuance choke point that requires an authenticated (web session OR
prior-token) identity MUST enforce requirePasskey." Member-set derived from the FULL
token-producing primitive — initial mint AND refresh re-mint — by grepping the
defining primitives across BOTH `src/app/api` AND `src/lib` (round-1 S1 and round-3
S11 each caught a member a route-only / initial-only grep missed):

```
grep -rlE 'createAuthorizationCode|extensionBridgeCode\.create|mobileBridgeCode\.create|issueAutofillToken|exchangeRefreshToken|refreshIosToken|extensionToken\.create' src/app/api src/lib
```

→ the code-derived member-set (verified rounds 1-3):

| Route / surface | Primitive | identity | Verdict |
|-----------------|-----------|----------|---------|
| `extension/bridge-code/route.ts` | `extensionBridgeCode.create` | `auth()` cookie | **GATE (C2)** — re-derive |
| `mobile/authorize/route.ts` | `mobileBridgeCode.create` | `auth()` cookie | **GATE (C3)** — re-derive |
| `mcp/authorize/consent/route.ts` (POST) | `createAuthorizationCode` | `auth()` cookie | **GATE (C6 — authoritative)** |
| `mcp/authorize/route.ts` (GET) | (redirects to consent) | `auth()` cookie | **GATE (C6 — UX early-reject)** |
| `extension/token/refresh/route.ts` | `extensionToken.create` | Bearer (cookieless) | **GATE (C8)** — re-derive |
| `mobile/token/refresh/route.ts` | `refreshIosToken` (lib) | DPoP (cookieless) | **GATE (C8, in route)** — re-derive |
| `mcp/token/route.ts` (refresh) | `exchangeRefreshToken` (lib) | DPoP (cookieless) | **GATE (C8, in route)** — re-derive; SA-skip |
| `mobile/autofill-token/route.ts` | `issueAutofillToken` (lib) | Bearer `IOS_APP` | **EXEMPT (C9)** — transitively gated via host token; allowlisted |

`createRefreshToken` is NOT in the set (round-3 F13): it is an initial-issue primitive
in the `mcp/token` authorization_code branch, not a refresh re-mint; the MCP rotation
primitive is `exchangeRefreshToken`.

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

**CI guard (C7)**: a grep-based check asserting every `route.ts` matching the
mint/re-mint primitive set calls `passkeyEnforcementBlocks` OR is on an explicit
allowlist with a reason (C9's autofill route is the one allowlisted member). Trigger
on the primitive ALONE, never `await auth()` (the cookieless refresh routes have no
`auth()`). Route-level gating (C8) keeps the guard's `route.ts` scope sufficient even
though `refreshIosToken`/`exchangeRefreshToken`/`issueAutofillToken` are lib functions.

## Forbidden patterns (diff-wide)

- `pattern: function isPasskeyGracePeriodExpired` outside the new shared module — reason: SSoT (C1).
- `pattern: webAuthnCredential\.count` inside `src/app/api/(extension|mobile|mcp)/**` — reason: the passkey-count belongs in `derivePasskeyState` (C1), not per-route (R1/R17).
- `pattern: \.user\.(requirePasskey|hasPasskey|requirePasskeyEnabledAt|passkeyGracePeriodDays)` inside a token-issuance route handler — reason: token gates re-derive via `derivePasskeyState` (fail-closed, live), they do NOT read the session snapshot (round-3 S13). (The web page-route is the sole legitimate reader of these via its `SessionInfo`.)
- New audit action literal for this block — reason: reuse `PASSKEY_ENFORCEMENT_BLOCKED` (C4).

## Testing strategy

**Mock prerequisite (round-3 T12 — SUPERSEDES the round-2 T8 `session.user` nesting
guidance)**: the token-issuance gates re-derive via `derivePasskeyState` (C1), they do
NOT read `session.user.*` passkey fields. So the mock seam for EVERY gated route is the
**Prisma layer that `derivePasskeyState` reads** (`webAuthnCredential.count` +
`tenant.findUnique`), OR a direct mock of `derivePasskeyState` itself — NOT `session.user`.
This makes the round-2 `MockSession.user` nesting concern MOOT for the token routes (they
no longer read those fields). Per-route mock seam:
- **C2 `bridge-code/route.test.ts`** — mock `derivePasskeyState` (or its underlying
  `webAuthnCredential.count` + tenant read) to drive the truth table; the existing
  `MockSession`/`auth()` mock just supplies `userId`+`tenantId`.
- **C3 `mobile/authorize/route.test.ts`**, **C6 `mcp/authorize/consent/route.test.ts` +
  `mcp/authorize/route.test.ts`** — same: mock `derivePasskeyState`; the inline
  `{ user: { id } }` literal supplies identity only.
- **C8 refresh routes (cookieless, Prisma-layer mocks — round-3 T12)**:
  - (6a) `extension/token/refresh/route.test.ts` — extend `mockTenantFindUnique`
    (`route.test.ts:27-30`, today only TTL fields) with the 3 passkey policy fields AND add
    a `webAuthnCredential.count` mock; OR mock `derivePasskeyState`. The gate uses the
    **token row's** `tenantId`, not `activeSession.tenantId` (S15).
  - (6b) `mobile/token/refresh/route.test.ts` — add a tenant-policy + `webAuthnCredential.count`
    mock (the route has no such read today; C8 adds one). `mockRefreshIosToken` stays a
    wholesale mock (the gate sits before it → RT8 assert it was NOT called).
  - (6c) **MCP → `oauth-server.test.ts`** (NOT `mcp/token/route.test.ts`, which mocks
    `exchangeRefreshToken` wholesale → RT5 violation): follow the C13 precedent
    (`oauth-server.test.ts:793-830`) — add `webAuthnCredential.count` + tenant-policy
    delegates; the gate is in the route, but the cap + SA-skip behaviors land here.
- The page-route caller still passes its FLATTENED `SessionInfo` (fields top-level); its
  tests already exist — verify green after the `recordPasskeyAuditEmit(userId, blockedPath, now)`
  arg change (C1/S14).
**Non-vacuity assertion per route (round-3 T12)**: in the `on+nopasskey+graceexpired` test,
assert the block ACTUALLY fires (denial signal present) AND the mint primitive was NOT called
(RT8 — see C8 below) AND in the `off` test the mint still happens — if a mis-wired mock makes
`derivePasskeyState` return `undefined`/falsy, both the block and off tests would pass
vacuously; the dual assertion catches it.
Mock-alignment sites: (1) C2 `bridge-code` derivePasskeyState mock, (2) C3 `mobile/authorize`
derivePasskeyState mock, (3) C6 `mcp/consent` + `mcp/authorize` derivePasskeyState mocks, (4)
auto-extension-connect.test.tsx `EXTENSION_CONNECT_ERROR_CODE` literal (+`PASSKEY_REQUIRED`),
(5a/5b/5c) the three refresh tests' Prisma-layer mocks above, (6) page-route + proxy tests'
`recordPasskeyAuditEmit` import + new `blockedPath` arg.

- **C1** → NEW `src/lib/auth/policy/passkey-enforcement.test.ts`: grace math
  (no enabledAt → true, zero grace → true, within → false, expired → true);
  `passkeyEnforcementBlocks` truth table; `recordPasskeyAuditEmit` dedup window **per
  `${userId}:${blockedPath}` key** (same user, different path → NOT deduped; same user+path
  within window → deduped — S14); `derivePasskeyState` (count-by-userId, policy-by-tenantId,
  `.toISOString()`, THROWS on DB error so callers fail closed — mock the Prisma client).
- **C2** → extend `bridge-code/route.test.ts`. Matrix: off→minted; on+haspasskey→minted;
  on+nopasskey+withingrace→minted (FR2); on+nopasskey+graceexpired→403 PASSKEY_REQUIRED
  + no bridge code + audit; **enabledAt=null→immediate 403** (F4); **derivePasskeyState throws
  → fail closed (no bridge code)** (S13). Assert audit emits ONLY `PASSKEY_ENFORCEMENT_BLOCKED`
  once (T6 — do not reuse `expectFailureEmit`).
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
- **C8 (refresh) — test target depends on the gate's LAYER (round-4 T18)**:
  - **Passkey gate matrix** (off→rotates; on+haspasskey→rotates; on+nopasskey+withingrace→rotates;
    on+nopasskey+graceexpired→**REFUSED**; derivePasskeyState throws→fail closed;
    SA-bound MCP `userId===null`→rotates) is ROUTE-level → test in the ROUTE test files:
    `extension/token/refresh/route.test.ts` (6a), `mobile/token/refresh/route.test.ts` (6b),
    **`mcp/token/route.test.ts` (6c — NOT `oauth-server.test.ts`)**. For 6c the existing
    wholesale `exchangeRefreshToken` mock IS the correct RT8 spy: the gate precedes it, so assert
    `mockExchangeRefreshToken.not.toHaveBeenCalled()` on the refused case (round-4 T18 corrects
    the round-3 target). Add `webAuthnCredential.count` + `tenant.findUnique` (or a
    `derivePasskeyState`) mock to each route test.
  - **RT8 dual assertion (round-3 T15)**: the "refused" case asserts BOTH the denial signal AND
    the mint primitive was NOT called — `mockExtTokenCreate` (6a), `mockRefreshIosToken` (6b),
    `mockExchangeRefreshToken` (6c).
  - **MCP absolute cap + C13 SA-membership skip** are LIB-level (inside `exchangeRefreshToken`) →
    test in **`oauth-server.test.ts`**: with a `familyCreatedAt` fixture older than the cap (or an
    injected `now`), the family is refused (chain converges) — assert no new tokens created (T13).
  - Grace branches are fixture-driven (`requirePasskeyEnabledAt = now - graceDays*2*MS_PER_DAY`
    for expired), NOT `vi.useFakeTimers` (T17).
- **C4 dedup (per user+path — S14)** → a 2nd attempt on the SAME path within the window emits
  no 2nd row; a block on a DIFFERENT path for the same user DOES emit. Every route test
  asserting dedup MUST call `_resetPasskeyAuditForTests()` in `beforeEach` (T10 — imported
  from the shared module per C1) and use distinct userIds across unrelated tests.
- **C7** → MANDATORY fixture self-test (T11/T14): exit 0 on the real tree; exit 1 on a
  tampered MINT-route fixture (check removed); **exit 1 on a tampered REFRESH-route fixture**
  (round-3 T14 — both fixture shapes required, since the guard now covers refresh re-minters);
  exit 0 when the tampered route is on the allowlist. Mirror
  `scripts/__tests__/check-permanent-delete-stepup.test.mjs`.
- **page-route / proxy** → existing tests stay green after repointing the
  `recordPasskeyAuditEmit` / `_*ForTests` imports to the shared module AND updating the
  `recordPasskeyAuditEmit(userId, blockedPath, now)` call/assertions + the `_passkeyAuditHasForTests(userId, blockedPath)` / `_passkeyAuditFirstKeyForTests` composite-key callers (C1, T2, S14, round-4 T19). **Add a page-route case (round-4 F18)**: same user, SAME blocked path within the window → one emit; same user, DIFFERENT blocked page path within the window → TWO emits (the new per-path behavior).

## Considerations & constraints

### Scope contract
- **SC1 — iOS client UX for passkey_required**: the iOS `AuthCoordinator` showing a
  friendly "register a passkey first" message is deferred unless trivial; the SERVER
  refusal (C3) is the security boundary and is in scope. Owner: iOS follow-up.
- **SC2 — exchange routes (token/exchange, mobile/token)**: the BRIDGE-code exchange
  paths (token/exchange, mobile/token authorization_code from a bridge code) stay
  out-of-scope (they consume a bridge code that already passed C2/C3). **ROUND-6 CORRECTION
  (F3)**: the MCP `authorization_code` → token exchange (`exchangeCodeForToken`) is NO
  LONGER scoped out — by the C8 principle (every mint re-derives), enforcement can flip
  within the code TTL, so it is now gated at the mint point inside `exchangeCodeForToken`.
- **ROUND-6 GATE-LAYER CORRECTION (supersedes the round-4 F9/T18 "gate at route level"
  decision for the token-CONSUMING paths)**: an external review found that gating in the
  ROUTE before the validation lib runs SUPPRESSES replay detection → family revocation
  (a token-theft defense). The gate for `exchangeRefreshToken` / `refreshIosToken` /
  `exchangeCodeForToken` is therefore INSIDE those lib functions, AFTER all token
  validation (replay/revoked/expired/client/cap/deactivated), BEFORE minting. The two
  refresh routes map the lib's passkey outcome → 403 + audit. C7 is lib-aware (asserts the
  lib functions contain `passkeyEnforcementBlocks`; the routes are allowlisted with a
  reason). The INITIAL-mint routes (C2/C3/C6) keep their route-level gate — they don't sit
  in front of theft-detection logic. See review.md round 6.
- **SC3 — session-callback enforcement (kill the session globally)**: rejected —
  deadlock risk (user can't reach the passkey-setup page) + UX collision with the
  existing web redirect. The choke-point approach (C2/C3/C6) is the chosen design.
- **SC4 — admin-role-gated mint routes** (`tenant/service-accounts/[id]/tokens`,
  `tenant/operator-tokens`, `tenant/scim-tokens`): NOT gated here. Different trust
  class — the admin is role-gated (`requireTenantPermission`) + step-up'd; "should an
  admin minting a machine credential also need their own passkey" is a separate policy
  question. Owner: future issue if tenants want admin-passkey on machine-credential mint.
- **SC5 — web page-route session-callback fail-OPEN (round-3 S13)**: `src/auth.ts:425-439`
  catches a DB error during the passkey fetch and leaves `requirePasskey:false`, so a web
  navigation during a DB blip is NOT redirected to passkey-setup. This is PRE-EXISTING in an
  UNCHANGED file (this PR does not modify `auth.ts`) and already logs
  `auth.session.passkey_data_fetch_failed`. The TOKEN-issuance paths are immunized by this PR
  (they re-derive via fail-closed `derivePasskeyState`, NOT the session snapshot), so the
  fail-open no longer affects token minting. The web-redirect fail-open is scoped OUT here:
  `TODO(passkey-enforcement-token-paths): make the auth.ts session-callback fail closed for
  the web redirect path` — owner: separate PR (changing it flips web behavior to redirect-to-
  setup on any DB blip, an availability tradeoff warranting its own review).
- **SC6 — MCP absolute family cap framing**: the cap added in C8 is MCP token-lifetime PARITY
  with extension (30 d) / iOS (7 d), a pre-existing gap independent of passkey enforcement. It
  is bundled here because it shares the MCP-refresh surface C8 already touches; it is NOT part
  of closing the passkey bypass (re-gating does that). Tracked as part of C8, not a separate PR.
- **SC7 — iOS AutoFill passkey upload exemption (C9)**: `mobile/autofill-token` is exempt from
  a direct passkey gate (transitively protected + deadlock-avoidance). Residual: ≤ host-token
  idle window of `passwords:write`. Owner: C9 + the C7 allowlist entry.

### Known risks
- **Fail-CLOSED token gates (round-3 S13)**: every token-issuance gate re-derives passkey
  state via `derivePasskeyState` (C1), which THROWS on DB error; the routes treat a throw as
  fail-closed (no mint / no rotation). This deliberately diverges from the `auth.ts` session
  callback (fail-open, SC5) — the token paths must never issue on an indeterminate passkey state.
- **Live-state invariant (F3) — now structural**: the gated routes read passkey state from a
  FRESH `derivePasskeyState` DB query at request time, NEVER from a cached session snapshot
  (e.g. the proxy's `getSessionInfo` cache) — so grace-expiry transitions take effect
  immediately, with no cache-TTL lag window.
- **Multi-tenant policy source (S15 + round-4 F16)**: each gate reads the tenant policy for the
  tenant the issued/refreshed token will be **bound to** — extension refresh = `activeSession.tenantId`
  (the route rebinds to the active tenant), iOS/MCP refresh = the token row's `tenantId` (cookieless,
  no rebind), initial mint (C2/C3/C6) = the route's resolved active `tenantId`. In every case the
  policy matches the token's destination tenant, so a multi-tenant user cannot mint/refresh a
  passkey-tenant token without a passkey (verified no bypass, F16).
- **Per-path audit dedup map (round-4 S18)**: keying the dedup by `${userId}:${blockedPath}` means
  the page-route (whose `blockedPath` is the client-supplied URL path) can have one blocked user
  fill up to `PASSKEY_AUDIT_MAP_MAX`=1000 distinct entries via many distinct `/dashboard/*` URLs;
  the existing LRU eviction then drops the oldest, so another user's next block emits an extra audit
  row (audit INFLATION, NOT a bypass — the block still happens). Token routes are unaffected
  (`blockedPath` is a hardcoded route string, ≤7 values). Accepted as a documented minor risk
  (pre-1.0; eviction is correct, no security property lost); a `${userId}:*` wildcard cap is a
  possible future hardening if audit volume becomes a problem.
- Grace-period semantics must match the web exactly (C1 reuses the same `isPasskeyGracePeriodExpired`).
- **MCP cap migration (S12)**: the `McpRefreshToken.familyCreatedAt` column does not exist
  today; C8 adds it + a backfill. Run `npm run db:migrate` on the dev DB with real data before
  PR (`feedback_run_migration_on_dev_db`); the integration tests verify post-state, not
  migration executability.

### Manual test artifact (R35 — Tier-2 auth-flow change, mandatory)
This PR changes token-refresh + auth-flow surfaces → a `docs/archive/review/passkey-enforcement-token-paths-manual-test.md`
is required before merge, with Pre-conditions / Steps / Expected / Rollback + adversarial
scenarios (post-grace refresh across ext/iOS/MCP; multi-tenant policy-source; SA-bound MCP
skip; autofill-token via a still-valid host token post-grace; DB-blip fail-closed). Authored
in Phase 2 alongside the implementation.

## User operation scenarios

1. Tenant turns on requirePasskey with a 7-day grace; a Google-OIDC user with no
   passkey connects the extension on day 3 → allowed (within grace). On day 10 →
   refused with PASSKEY_REQUIRED; the connect card says "register a passkey".
2. Same user opens the iOS app on day 10 → authorize refused with passkey_required.
3. User registers a passkey → `hasPasskey` true → both paths proceed.
4. Tenant without requirePasskey → no change anywhere.

## Go/No-Go Gate

All contracts re-locked after round 5 (focused confirmation: F16 extension-tenant reversal,
F17 MCP RLS, T18 test target, iOS token-row tenantId — all code-verified; R42 member-set
independently re-derived and complete). 5 review rounds total; all Critical/Major findings
resolved and verified against the live codebase.

| ID | Subject                                              | Status  |
|----|------------------------------------------------------|---------|
| C1 | Shared `passkeyEnforcementBlocks` + `derivePasskeyState` (fail-closed, tx-aware) + per-path audit dedup | locked  |
| C2 | Enforce in extension bridge-code (re-derive; tenantId from route's DB read) | locked  |
| C3 | Enforce in iOS mobile authorize (re-derive, error=passkey_required) | locked  |
| C4 | Audit on token-path block (deduped per user+path)    | locked  |
| C5 | Extension client surfacing of PASSKEY_REQUIRED       | locked  |
| C6 | Enforce in MCP OAuth authorize GET + consent POST (re-derive; GET adds tenantId read) | locked  |
| C7 | CI guard (primitive set fixed, autofill allowlisted, pre-pr wired, refresh self-test) | locked  |
| C8 | Refresh grant (ext=activeSession.tenantId / iOS+MCP=token-row tenantId, route-level, fail-closed, MCP RLS pre-read) + MCP familyCreatedAt 2-step migration + lib-level cap | locked  |
| C9 | Classify `mobile/autofill-token` transitively-protected-exempt | locked  |

## Implementation Checklist (Phase 2-1)

Member-set re-derived (grep `createAuthorizationCode|extensionBridgeCode\.create|mobileBridgeCode\.create|issueAutofillToken|exchangeRefreshToken|refreshIosToken|extensionToken\.create` over `src/app/api` + `src/lib`) — matches the locked plan; no extra member.

**Batch 1 — C1 foundation (must land first; everything imports it):**
- NEW `src/lib/auth/policy/passkey-enforcement.ts`: `isPasskeyGracePeriodExpired` (moved), `passkeyEnforcementBlocks`, `derivePasskeyState` (tx-aware, count-by-userId, policy-by-tenantId, toISOString, throws), `recordPasskeyAuditEmit(userId, blockedPath, now)` + Map + `PASSKEY_AUDIT_DEDUP_MS`/`PASSKEY_AUDIT_MAP_MAX` + `_resetPasskeyAuditForTests`/`_passkeyAuditSizeForTests`/`_passkeyAuditHasForTests(userId, blockedPath)`/`_passkeyAuditFirstKeyForTests`.
- `src/lib/proxy/page-route.ts`: remove the relocated defs, import from the new module; update the call to `recordPasskeyAuditEmit(userId, pathWithoutLocale, Date.now())`; keep `PASSKEY_EXEMPT_PATHS`/`isPasskeyExemptPath` local.
- NEW `src/lib/auth/policy/passkey-enforcement.test.ts` (C1 unit tests).
- `src/lib/proxy/page-route.test.ts` + `src/__tests__/proxy.test.ts`: repoint imports; update composite-key probe callers (`:1200-1233`); add F18 same-user-different-path case.

**Batch 2 — C8 MCP schema + lib (parity cap):**
- `prisma/schema.prisma`: add `familyCreatedAt` to `McpRefreshToken`; TWO migrations (nullable+backfill, then NOT NULL+default).
- `src/lib/constants/auth/mcp.ts`: `MCP_REFRESH_TOKEN_FAMILY_ABSOLUTE_TIMEOUT_SEC = 30 * SEC_PER_DAY`.
- `src/lib/mcp/oauth-server.ts`: propagate `familyCreatedAt` in `createRefreshToken` + carry across rotation in `exchangeRefreshToken` create + add to `findUnique` select; add `now?: () => number`; add the absolute-cap check (lib-level).
- `src/lib/mcp/oauth-server.test.ts`: update C13 `baseRt` fixtures with `familyCreatedAt`; add the cap test.

**Batch 3 — C2/C3/C6 initial-mint gates (re-derive; needs Batch 1):**
- `src/app/api/extension/bridge-code/route.ts` (C2), `src/app/api/mobile/authorize/route.ts` (C3), `src/app/api/mcp/authorize/route.ts` GET + `src/app/api/mcp/authorize/consent/route.ts` POST (C6) + their tests (mock `derivePasskeyState`).

**Batch 4 — C8 refresh gates (route-level, fail-closed; needs Batch 1+2):**
- `src/app/api/extension/token/refresh/route.ts` (gate on `activeSession.tenantId`), `src/app/api/mobile/token/refresh/route.ts` (token-row tenantId), `src/app/api/mcp/token/route.ts` (withBypassRls pre-read + SA-skip) + their tests.

**Batch 5 — C5 + C7 + C9 + R35 (mostly independent):**
- C5: `src/lib/extension-connect-request.ts` (add `PASSKEY_REQUIRED` to `EXTENSION_CONNECT_ERROR_CODE` + `coerceErrorCode` branch + EXPORT it), `extension/src/background/token-handler.ts` (`extractErrorCode`), `src/components/extension/auto-extension-connect.tsx` (card) + tests; `messages/en.json` + `messages/ja.json`.
- C7: `scripts/checks/check-passkey-mint-gate.sh` + `scripts/checks/passkey-mint-gate-exempt.txt` (autofill entry) + `scripts/__tests__/check-passkey-mint-gate.test.mjs` + wire into `scripts/pre-pr.sh`.
- C9: the autofill allowlist entry (in C7's exempt file) — no route code change.
- R35: `docs/archive/review/passkey-enforcement-token-paths-manual-test.md`.

Test trees to keep in sync (R19): `proxy.test.ts` + `page-route.test.ts` (C1); per-route co-located `*.test.ts` (no centralized `__tests__` duplicates for these routes).
