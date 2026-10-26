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
- **`mobile/autofill-token` outcomes match the former `checkAuth` path.**
  - The batch first answered a client-kind mismatch with 403 and an invalid token with the
    validator's error code.
  - Both were restored, matching the plan's "keeps its outcomes":
    - a failure gives a bare 401 `UNAUTHORIZED`;
    - scope is checked before client kind;
    - a non-`IOS_APP` token gives 401.
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
