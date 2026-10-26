# Coding Deviation Log: session-api-passkey-gate

## Batch 1a — proxy and session plumbing
- **`SessionInfoSchema.passkeyStateDegraded` is required, not optional.**
  - An optional key would be stripped silently on a cache read. Requiring it means a cached
    entry from before the deploy fails the schema and is fetched once more.
  - Cost: one extra session fetch per live session after deploy.
- **Tier A Auth.js entries follow Auth.js's own path parse.** The path is split on `/` and
  empty segments are dropped, so `/api/auth/session/` and `/api/auth//session` count as
  `session`. This matches what Auth.js dispatches. No non-Auth.js route under `/api/auth`
  starts with an Auth.js action name.
- **The gate audits only when the session has a `userId`.** A valid session without one cannot
  be cached and does not reach the gate in practice.

## Batch 1b — routes
- **`mobile/autofill-token` keeps the former `checkAuth` outcomes for extension tokens.**
  - The batch first answered a client-kind mismatch with 403 and an invalid token with the
    validator's error code.
  - Both were restored, matching the plan's "keeps its outcomes":
    - any extension-token failure gives a bare 401 `UNAUTHORIZED`;
    - scope is checked before client kind;
    - a non-`IOS_APP` token gives 401.
  - One outcome differs (code review round 1 FN-5): an `api_` key is not an extension token,
    so a passkey-blocked one now gets 401 instead of `checkAuth`'s 403 `PASSKEY_REQUIRED`.
    This is harmless: an `api_` key never passed the `IOS_APP` check, so it could never mint.
- **`v1/openapi.json` audits a blocked session through the API gate's own writer.** It calls
  `auditSessionPasskeyBlock` with `blockedPath("GET", "/api/v1/openapi.json")`, so the row
  reads `"GET /api/v1"` and is deduped by the same Redis-shared limiter as the proxy's rows.
  - The batch first followed the sibling own-gate routes (`mobile/authorize`, `mcp/authorize`):
    a raw `"/api/v1/openapi.json"` path deduped by the per-process map.
  - Changed after the Phase 2 self-check: this is a session-request refusal, the class the API
    gate audits, so it takes that class's shape and limiter. The siblings refuse at a
    credential-mint point and keep theirs.

## Batch 2 — client
- **`LOADING` → `LOCKED` happens during render, not in the status effect.**
  `react-hooks/set-state-in-effect` rejects a `setState` there. The render-time transition
  follows the file's existing `prevSessionStatus` pattern, with the same guard. Behaviour is
  unchanged, and the retry/fallback timers never arm.
- **`onRegistered`'s body (`update()`, then `hardNavigate`) lives in `PasskeyRequiredScreen`.**
  The card only awaits the callback, so it never imports `hardNavigate`. The ordering cell is
  in the screen's test.
- **The screen-mounted flag is set in a layout effect.** Child passive effects run before the
  parent's, so the card's mount fetches would otherwise run before the flag; red-proved.
- **`use-bulk-action.test.ts` is unchanged.** jsdom's path is `/`, so the reaction exits early.
  The plain-object-403 case is pinned under `/dashboard` in `url-helpers.test.ts`.
- **Re-bootstrap copy:** "Re-enable" became "Enable" (ja 有効化) so it claims no key rotation.
  The card's `WebAuthn.vaultMustBeUnlocked` became `registerLockedPrfHint`;
  `Vault.vaultMustBeUnlocked` is unrelated and untouched.

## Batch 3 — gates and tests
- **The reader scan decides per file.** A route file with any reader reference counts as a
  reader for every method it declares. This is documented as the gate's floor, along with
  wrappers not being followed.
- **CI gains `WEBAUTHN_RP_ID` and a dummy `WEBAUTHN_PRF_SECRET`.** These go in the e2e job's
  env, in the same form as its other dummy keys. Without the PRF secret, registration never
  requests the PRF extension, so the re-bootstrap offer cannot appear.
- **`seedVaultReadyUser` moved from `e2e/global-setup.ts` to `e2e/helpers/vault-user.ts`,** with
  a `tenantId` parameter, so the spec seeds a user per attempt without duplicating it
  (refactor not in plan).
- **The integration red proof for tenant-scoped invalidation is simulated** by filtering to the
  first session's tenant. The session-only bypass grant cannot read `users`.
- **Deferred: the E2E spec has not been run locally.**
  - It is written, type-checks and lints clean, and the CI e2e job runs it.
  - It could not run here. The main checkout's dev server owns `.next`. In the scratchpad copy,
    Turbopack refused a symlinked `node_modules`, and restarting with `--webpack` was not
    permitted.
  - What would settle it: a green CI e2e job, or a local run on a free port with the e2e
    prerequisites.

## Code review round 1 — server and client fixes
- **D5 always requires recency (SEC-1, user decision 2026-10-27).**
  - `register/options` and `register/verify` call `requireRecentCurrentAuthMethod`
    unconditionally, before the challenge is minted or consumed, as credential delete does.
  - Their `derivePasskeyState` read is gone, so neither route reads the passkey state any more.
    The plan's red-proof items "let D5 read `passkeyBlocked`" and "make D5 use the createdAt-only
    `requireRecentSession`" now concern only the helper choice, since there is no blocked branch.
  - T-5 is moot: with no DB derivation left on these routes, there is no rejection to pin.
  - The Tier B reasons for both routes read "always recency-bound" in `session-passkey-gate.ts`
    and `route-policy-manifest.json`.
  - The route cells run the real helper over a mocked session row, so the `STEP_UP_WINDOW_MS`
    boundary is exercised at the route.
- **The last passkey cannot be deleted past grace (FN-2, user decision 2026-10-27).**
  - The credential `DELETE` answers 403 `CANNOT_DELETE_LAST_PASSKEY` when the requirement is on,
    its grace period has expired, and the user holds one passkey across all tenants.
  - 403 follows the file's `CANNOT_*` convention, where a policy denial is 403
    (`CANNOT_REMOVE_OWNER`). It is not 409.
  - The count comes from a new `countUserPasskeys` in `passkey-enforcement.ts`. It is the same
    user-global count, read under the same bypass grant.
  - Not serialized: two parallel deletes of a user's last two passkeys can both pass.
    - The cross-tenant count needs a bypass read, and a bypass cannot nest inside the
      tenant-scoped delete transaction. So no single advisory-lock transaction covers both.
    - The race needs two fresh step-ups by the user themselves. It ends where the refusal would
      otherwise have left them (blocked, and re-registering after a fresh sign-in), so it opens no
      bypass of the requirement.
  - The manual test's step 8 had expected "delete the last passkey, then the next API call
    returns `PASSKEY_REQUIRED`". That flow is no longer reachable, and the step now tests the
    refusal.
- **Page-navigation `blockedPath` is `"PAGE /dashboard"` or `"PAGE /admin"` (SEC-2).** The
  closed value is also the dedup key. Two pages in one area therefore share one row per window,
  where they used to write one row each.
- **`/api/internal/audit-emit` itself still accepts caller-supplied metadata** for its
  allowlisted actions, within the size bounds. Closing the page proxy's path does not stop an
  authenticated caller from posting a `PASSKEY_ENFORCEMENT_BLOCKED` row with free-text metadata
  directly. Not changed here; noted for follow-up.

## Round 1 — tests/CI
- **The `auth.ts` cross-tenant cell (T-4/T13) is a new file,
  `session-passkey-cross-tenant.integration.test.ts`.**
  - `session-passkey-gate.integration.test.ts` mocks `@/auth`, so it cannot hold the cell.
  - The new file drives the real `callbacks.session`, captured from the config `src/auth.ts`
    hands a mocked `next-auth`. This is the `tenant-claim-binding` pattern, used for the same
    module-resolution reason.
- **T-2 did not reproduce as a failing re-run.**
  - No cell in `route-policy-manifest.test.ts` asserts audit rows, and two unmocked runs in a
    row against the dev Redis both passed.
  - The defect that does show is the write itself: an unmocked run left 72
    `rl:passkey_session_gate_audit:u-1:*` keys in the real Redis, and a mocked run leaves none.
- **The un-intercepted E2E minimal-screen cell cannot see the mounted-flag mutation on its own.**
  Nothing the screen calls is refused there, so `reactToPasskeyRequired` never fires. It fails on
  any `/api/*` 403, unreadable bodies included, and on any main-frame navigation once the screen
  is up. (Corrected in round 2: an E2E cell can see the mutation when it refuses a screen call
  itself — see "Code review round 2".)
- **The WebAuthn E2E env has a single source.**
  - `WEBAUTHN_RP_ID` and `WEBAUTHN_PRF_SECRET` were removed from the CI `e2e` job.
  - The PRF secret (a dummy) joined `E2E_WEBAUTHN_SERVER_ENV`. Playwright merges `webServer.env`
    over `process.env`, and `load-env` never overwrites a variable that is already set.
  - With `E2E_BASE_URL` set, no web server is started, so the external server must carry these
    values itself, as before.
- **Still deferred:** the E2E spec has not been run locally (same reasons as Batch 3). It
  type-checks and lints clean.

## Code review round 2
- **One read for the last-passkey refusal (FN-8).** `derivePasskeyState` also returns
  `passkeyCount`, the same user-global count it reduces to `hasPasskey`; the credential `DELETE`
  decides on `passkeyCount <= 1` from that one snapshot. `countUserPasskeys` and its two unit
  cells are deleted. Every other caller only passes the result to `passkeyEnforcementBlocks`,
  which ignores the extra field, so their behaviour is unchanged.
- **The refusal runs before the step-up (FN-7).** Order in `DELETE`: ownership lookup (404), the
  last-passkey refusal, then `requireRecentCurrentAuthMethod`. A stale session deleting its last
  passkey past grace gets `CANNOT_DELETE_LAST_PASSKEY`, not a re-authentication prompt that would
  only lead to it. The refusal discloses only the caller's own credential list and tenant policy
  (both readable by the session already); a foreign id still stops at the 404 before the policy
  read. A delete that proceeds still needs the step-up.
- **S2-2 (an admin-side revoke of a member's credential) is a follow-up, not done here.** Until
  it exists, the incident path for a member with a compromised sole passkey and no second
  authenticator is the tenant admin turning `requirePasskey` off (S2-1, documented in
  `docs/security/policy-enforcement.md` and manual-test step 8). No issue was filed from this
  round.
- **T2-1: the refused-call E2E cell refuses `GET /api/webauthn/credentials`, at mount.**
  - The screen calls two endpoints on mount, the credential list and `GET /api/user/auth-provider`.
    Neither is retried; the list is fetched again only after a register or delete.
  - The list is refused because its failure is observable: the card's "failed to load" toast
    appears only after `fetchApi` returned, i.e. after the reaction finished. That toast bounds
    the observation without a sleep. The auth-provider probe fails silently, so nothing would
    bound it.
  - "With the screen up" is the mount itself: no refetch can be triggered without registering,
    which reloads the tab by design. The mount fetch is also exactly the case the layout effect
    exists for.
  - Not run here (same reasons as Batch 3); it type-checks and lints clean.
  - Its red proof is owed to the first environment that can run the E2E spec. It reads the
    in-page record of cross-document navigate events (code review round 4, T4-1), not
    `framenavigated`:
    - drop `setPasskeyRequiredScreenMounted(true)` and expect at least one cross-document entry;
    - drop the listener install and expect the allow side to fail. The allow side is a
      `location.href` reload that must record exactly one cross-document entry.
- **T2-2: the observation bound is the screen's named mount calls.** Each of
  `GET /api/auth/session` (the session provider), `GET /api/webauthn/credentials` and
  `GET /api/user/auth-provider` is awaited by name, and the set of `fetch`/`xhr` calls observed
  under `/api/` must equal that set. Calls are compared as a set, since the session provider may
  read the session more than once. Non-fetch requests (a CSP report) are not part of the set.
- **T2-6: the register cells' session double answers only the cookie's digest.** It returns the
  row only when `where.sessionToken === hashSessionToken(TEST_SESSION_TOKEN)`, and null
  otherwise. The credential `DELETE` cells that run the real step-up use the same double.
- **T2-3/T2-4: integration.** `session-passkey-cross-tenant.integration.test.ts` gains three
  cells: `passkeyCount` is 2 with one credential in the requiring tenant and one in another; the
  real `DELETE` route deletes the requiring tenant's credential in that state; control, the
  requiring tenant's credential alone counts 1 and its delete is refused. The route cell stubs
  only `auth()` (through the mocked `next-auth`) and signs in with a real fresh Session row.
- **Observation, not changed:** the integration run prints pg's "client is already executing a
  query" deprecation once. The trace stops inside Prisma, so its source is not attributed.
  `derivePasskeyState` runs its two reads with `Promise.all` on one transaction client, which
  matches it, but the session-callback cells in the same file run first.
- **Follow-up candidate (not fixed here): `Promise.all` over one interactive transaction
  client.**
  - **Where:** `derivePasskeyState`, `src/auth.ts`'s session callback and about 15 other
    pre-existing sites (`rg -n -U 'Promise\.all\(\[\s*\n?\s*tx\.' src`).
  - **Effect:** two queries are issued concurrently on one pg client. pg queues them today but
    prints the deprecation "client is already executing a query", and it will refuse them in a
    future major version.
  - **Why not here:** the class predates this branch, spans unrelated features, and its fix
    (sequential awaits) belongs in its own change.

## Code review round 3
- **T3-1: the no-reload E2E cell detects a reload attempt in the page, not by event ordering.**
  - An init script, top frame only, records Navigation API `navigate` events in
    `sessionStorage`, which survives a same-origin reload. `hardNavigate`'s `location.href`
    assignment fires that event before `fetchApi` returns, so before the toast that ends the
    observation.
  - Each entry keeps `destination.sameDocument`. Next's router calls `replaceState` on
    hydration, which is a same-document navigate (round 4, T4-1), so only cross-document entries
    count as a reload, and none may exist.
  - A missing Navigation API fails.
  - The allow side is a real cross-document `location.href` reload that must record exactly one
    entry (round 4, T4-2).
  - `framenavigated` and the URL stay as secondary checks.
- **T3-2:** the refused-response wait matches status 403, since `next dev` StrictMode mounts the
  card twice and the second fetch passes through.
- **F3-1:** the incident procedure now states that turning `requirePasskey` off is tenant-wide,
  and that re-enabling restarts the grace period. Immediate re-enforcement needs
  `passkeyGracePeriodDays` set to null first.

## Code review round 4
- **T4-1, T4-2, T4-3:** the round-3 counter could not read 0 on a passing build, because Next's
  `HistoryUpdater` `replaceState` fires `navigate` on hydration. It is replaced by the
  cross-document record described under T3-1, with a cross-document reload as the allow side
  and the init script limited to the top frame.
- **F4-1, S4-1:** the incident note distinguishes the policy card (which clears the grace period
  on switch-off) from the API (send null in the same request). It also states the up-to-1 h tail
  of MCP access tokens issued while the requirement was off.
