# extension-jkt-trust-path — Plan v3

Follow-up to PR #491 (DPoP sender-constrained tokens). Closes the High-severity
XSS gap surfaced in the post-merge review.

Review log: `docs/archive/review/extension-jkt-trust-path-review.md`.
v1 had 3 Critical + 17 Major findings (Round 1, all resolved).
v2 introduced 2 Critical + 11 Major + 11 Minor (Round 2). v3 addresses all of them.

## Project context

- **Type**: web app (Next.js 16 App Router + Prisma + Auth.js v5) + Chrome MV3 browser extension (TS + Vite)
- **Test infrastructure**: vitest unit + real-DB integration (`npm run test:integration`) + Playwright E2E + CI/CD (`scripts/pre-pr.sh`)

## Background

PR #491 made extension tokens DPoP-bound: every BROWSER_EXTENSION token carries a `cnf_jkt`, validateExtensionToken requires a matching DPoP proof, and refresh preserves the binding. This eliminates "stolen Bearer replayed from attacker's machine" attacks.

However, the JKT that the binding uses still flows through `window.postMessage`:

```
Web App JS  -- EXT_JKT_REQUEST  -->  content script  -->  background SW
Web App JS  <-- EXT_JKT_READY -- (cnfJkt = current IDB key thumbprint)
Web App JS  -- POST /api/extension/bridge-code { cnfJkt }  -->  server
```

Same-origin XSS satisfies all the postMessage filters and can spoof
`EXT_JKT_READY` with an **attacker-controlled jkt**. The server then issues a
bridge-code → token bound to the attacker's key — DPoP works as designed but
binds the wrong key.

## Threat model

| Threat | PR #491 outcome | v2 outcome |
|---|---|---|
| Bearer captured by XSS, replayed from attacker laptop | Mitigated (DPoP-bound) | Mitigated |
| XSS spoofs JKT, gets attacker-key-bound token, uses from attacker laptop | NOT mitigated | **Mitigated** |
| Stolen bridge-code from a 3rd party, valid DPoP signed by victim's key | Not applicable | Not applicable |
| Stolen bridge-code, invalid DPoP (attacker doesn't have victim's private key) | DoS (code burned) | **Mitigated (code not consumed on DPoP failure)** |
| XSS triggers an unwanted `EXT_CONNECT_REQUEST` → silent extension connect | NOT mitigated | **Documented as residual** — token bound to extension's own non-extractable key; equivalent to XSS-acts-as-user (out of scope for both PRs). Defense-in-depth via `userActivation.isActive` deferred to a future hardening pass. |
| Multi-environment dev/staging/prod with different extension IDs | Broken | Supported (CSV allowlist) |
| Env var unset/empty | Undefined | Fail-closed |

## Goals

1. **Server-trusted `cnf_jkt`** — derived from a server-verified DPoP proof, never from a body field.
2. **Browser-set Origin** — `/api/extension/bridge-code` requires `Origin: chrome-extension://<id>` (allowlist of extension IDs), which the browser sets and MAIN-world JS cannot forge.
3. **No trust in postMessage payloads** — Web App's role is reduced to "ping the content script" (`EXT_CONNECT_REQUEST` carries only a reqId).
4. **DPoP failure must not burn the bridge-code** (DoS hardening via SELECT → verify → CAS).
5. **Strict from day 1**: server rejects body `cnfJkt`; deprecated handler removed in same PR; lockstep deploy.

## Contracts

### C1 — `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` env var

- **Signature** (zod, added to `src/lib/env-schema.ts`):
  ```ts
  EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: z
    .string()
    .regex(/^chrome-extension:\/\/[a-p]{32}(,chrome-extension:\/\/[a-p]{32})*$/)
    .optional()
  ```
- **Invariants**:
  - Required when production extension is deployed; **server fails closed** if unset and a request arrives at `/api/extension/bridge-code`.
  - Empty string is invalid (Zod regex rejects).
  - Regex matches **real** Chrome extension IDs (`[a-p]{32}`, mapped from hex via Chrome's encoding). Aligns with existing `src/lib/http/cors.ts:45`.
- **Forbidden patterns**:
  - `pattern: \.includes\((req|origin)` — reason: substring-match origin compare is allowlist-bypass-able. Must use exact equality on a `Set<string>`.
  - `pattern: \.startsWith\(.*chrome-extension` — reason: same.
- **Acceptance criteria**:
  - `env-schema.test.ts` accepts a single `chrome-extension://abcdefghijklmnopabcdefghijklmnop` value.
  - Accepts CSV of 2+ values.
  - Rejects uppercase chars, digits, trailing/leading comma, spaces.
  - `check:env-docs` (`scripts/checks/check-env-docs.sh`) passes: schema ↔ `.env.example` ↔ allowlist ↔ docker-compose all aligned.

### C2 — New route classification `API_EXTENSION_BRIDGE_CODE` + orchestrator wiring

- **Signature** (in `src/lib/proxy/route-policy.ts`):
  ```ts
  export const ROUTE_POLICY_KIND = {
    ...,
    API_EXTENSION_BRIDGE_CODE: "api-extension-bridge-code",
  } as const;
  export type RoutePolicy =
    | ...
    | { kind: typeof ROUTE_POLICY_KIND.API_EXTENSION_BRIDGE_CODE };
  ```
- **Invariants**:
  - `classifyRoute("/api/extension/bridge-code")` returns this kind. The new branch in `classifyRoute()` MUST be placed BEFORE the `pathname.startsWith(API_PATH.EXTENSION)` prefix-match block (else the prefix loop captures it as `API_SESSION_REQUIRED` and v2's CSRF gate misread reproduces). Mirror the existing `API_EXTENSION_EXCHANGE` branch position at `route-policy.ts:119-121`.
  - **Orchestrator wiring (load-bearing — Round-2 S14/T16 root cause)**: `src/lib/proxy/api-route.ts` MUST add an early-return branch for `policy.kind === API_EXTENSION_BRIDGE_CODE` BEFORE the CSRF gate fires (currently at `api-route.ts:54`). Mirror the existing `PUBLIC_SHARE` / `PUBLIC_RECEIVER` / `API_V1` / `API_EXTENSION_EXCHANGE` early-return blocks at lines 34-46. The early-return performs: `(a)` Origin allowlist check (see C4 step 2), `(b)` apply CORS headers via C3, `(c)` `return NextResponse.next()` — letting the route handler do auth() / DPoP verify / etc.
  - **Tenant IP access restriction (Round-3 S21)**: the early-return bypasses the proxy's `checkAccessRestrictionWithAudit` step that normally runs for session-authenticated routes. The bridge-code route handler MUST therefore call `checkAccessRestrictionWithAudit(req, userId, tenantId)` (or equivalent helper) AFTER `auth()` resolves the user — see C4 step 4.5. Without this, a session cookie shared to a non-allowlisted IP (e.g. cookie sync across devices) could mint a new extension token outside the tenant's `allowedIpRanges`, bypassing the policy that PR #491 / Tailscale enforcement was designed to enforce.
  - The proxy CSRF gate (`shouldEnforceCsrf` in `csrf-gate.ts:42`) is **request-attribute-gated, not classification-gated**. Classifying alone is insufficient to bypass it.
  - Auth.js session check is performed inside the route handler (`auth()` call) — the proxy no longer gates session for this route.
- **Forbidden patterns**:
  - `pattern: classifyRoute.*EXTENSION_BRIDGE_CODE.*API_SESSION_REQUIRED` — reason: the old classification re-triggers CSRF gate.
  - `pattern: API_EXTENSION_BRIDGE_CODE` appearing **after** `assertSessionCsrf` / `shouldEnforceCsrf` in `api-route.ts` (line-order grep) — reason: late dispatch is the original S14 failure mode.
  - `pattern: API_EXTENSION_BRIDGE_CODE` appearing **after** `pathname.startsWith(API_PATH.EXTENSION)` in `route-policy.ts` (line-order grep) — reason: late classification leaks to SESSION_REQUIRED.
- **Acceptance criteria**:
  - `route-policy.test.ts` asserts the new kind for the bridge-code path.
  - `cors-gate.test.ts` updated: bridge-code no longer matches "session-required" sub-suite.
  - `proxy.test.ts` adds the C8 cases. Crucially, the "Origin not allowlisted → 403" assertion MUST distinguish 403-from-CSRF-gate (proxy layer) vs. 403-from-route-Origin-check (handler layer) by inspecting the response body's `error` code (CSRF gate returns `API_ERROR.INVALID_ORIGIN`; route handler returns a different code or no body — pick one for the route handler and assert that specifically).

### C3 — CORS for chrome-extension on bridge-code

- **Signature** (extend `src/lib/http/cors.ts` `corsHeaders()` + `handleApiPreflight()`):
  - When `routeKind === API_EXTENSION_BRIDGE_CODE` AND `origin` is in the allowlist parsed from `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS`, return:
    ```
    Access-Control-Allow-Origin: <exact request origin>
    Access-Control-Allow-Credentials: true
    Access-Control-Allow-Headers: Content-Type, DPoP
    Access-Control-Allow-Methods: POST, OPTIONS
    Vary: Origin
    ```
  - Otherwise (origin not in allowlist OR no allowlist match): return no CORS headers (browser blocks).
  - **Tighten existing `cors.ts:45` `isExtensionOrigin()` regex** from `[a-z]{32}` to `[a-p]{32}` in this PR (single-line edit) to match real Chrome extension ID alphabet and align with C1.
- **Invariants**:
  - Exact-string match between request `Origin` and one of the parsed allowlist values. Use a precomputed `Set<string>` built once per process.
  - `Vary: Origin` is set so any caching layer keys correctly.
  - **`Allow-Credentials: true` is emitted for chrome-extension origin ONLY when `routeKind === API_EXTENSION_BRIDGE_CODE`**. Existing Bearer-bypass routes (EXTENSION_TOKEN / EXTENSION_TOKEN_REFRESH / EXTENSION_TOKEN_EXCHANGE / EXTENSION_KEY_RESET) must continue to emit NO `Allow-Credentials` header for chrome-extension origin (those routes use Bearer; cookies must not be implicitly trusted there).
  - Preflight (`OPTIONS`) returns 204 with the headers above. `handleApiPreflight` (`src/lib/proxy/preflight.ts` or equivalent) MUST gain an `isBridgeCodeRoute` flag and the orchestrator MUST pass it.
- **Forbidden patterns**:
  - `pattern: \.includes\(origin\)` on a comma-joined string — reason: substring bypass.
  - `pattern: Allow-Credentials.*isExtensionOrigin` outside an `API_EXTENSION_BRIDGE_CODE` guard (line-order grep) — reason: prevents accidental Allow-Credentials leak to Bearer-bypass routes.
- **Acceptance criteria**:
  - `cors-dpop-header.test.ts` extended with chrome-extension origin cases (allowed, not allowed, missing).
  - Explicit negative test: chrome-extension Origin + Bearer-bypass route (e.g., EXTENSION_TOKEN_REFRESH) → response has NO `Access-Control-Allow-Credentials`.
  - **Preflight + actual-response symmetry** (Round-3 S23): for the bridge-code route with an allowlisted extension Origin, BOTH the OPTIONS preflight response AND the actual POST response carry `Access-Control-Allow-Credentials: true`. For non-bridge-code routes from extension Origin, BOTH carry no such header. Asymmetry triggers confusing browser-level errors.
  - Manual: DevTools Network tab shows `Access-Control-Allow-Credentials: true` on the bridge-code response only.

### C4 — `POST /api/extension/bridge-code` rewrite

- **Signature**:
  ```ts
  Request:
    method: POST
    headers:
      Origin: chrome-extension://<32-char id>     ← browser-set, allowlist-checked
      Cookie: <Auth.js session cookie>            ← user authn
      DPoP: <proof signed by extension key>       ← cnfJkt source
      Content-Type: application/json
    body: {}                                      ← empty; cnfJkt comes from DPoP

  Response 201 (success):
    body: { code: string<64 hex>, expiresAt: ISO8601 }

  Response 401: invalid DPoP, invalid session
  Response 403: Origin not in allowlist, env var unset
  Response 400: malformed body / unknown fields
  ```
- **Invariants**:
  - Order of checks (cheap → expensive, fail-fast). **Session check is moved BEFORE DPoP verify** because cookie lookup is one Redis/DB hit while DPoP verify is EC math + JTI cache I/O — unauthenticated callers must not burn EC CPU:
    1. IP-keyed rate limit (60/min/IP, fail-closed on Redis error) — **before** Origin
    2. Origin allowlist (exact match against `Set<string>`)
    3. Body schema `z.object({}).strict()` (rejects unknown keys including `cnfJkt`)
    4. Auth.js session check (`auth()`)
    4.5. **Tenant IP access restriction** (`checkAccessRestrictionWithAudit(req, userId, tenantId)`) — closes Round-3 S21 since the proxy early-return bypassed the normal IP gate. Returns 403 if request IP is outside tenant policy.
    5. Step-up check (`requireRecentCurrentAuthMethod`)
    6. Per-user rate limit
    7. DPoP proof verify (extract `cnfJkt` from `result.jkt`)
    8. DB write (existing `MAX_ACTIVE` enforcement + create row)
  - `cnf_jkt` stored in DB == `verifyDpopProof().jkt` (the verifier's returned, validated thumbprint — NOT a re-read header field).
  - Verify call signature (no `expectedAth`, no `expectedCnfJkt`):
    ```ts
    const result = await verifyDpopProof(dpopHeader, {
      expectedHtm: "POST",
      expectedHtu: canonicalHtu({ route: API_PATH.EXTENSION_BRIDGE_CODE }),
      expectedNonce: null,
      jtiCache: getJtiCache(),
    });
    if (!result.ok) return unauthorized();
    const cnfJkt = result.jkt;
    ```
- **Forbidden patterns**:
  - `pattern: bodyResult\.data\.cnfJkt` — reason: cnfJkt MUST NOT come from body.
  - `pattern: BridgeCodeIssueSchema = z.object\(\{[\s\S]*cnfJkt` — reason: schema must not declare cnfJkt.
  - `pattern: expectedCnfJkt:` in bridge-code route — reason: verifier extracts jkt; we don't pre-bind.
  - `pattern: \.passthrough\(\)|\.catchall\(` on the body schema — reason: strict schema is the spoofing-gap guard; permissive schema re-opens it. Future fields require an explicit plan amendment.
  - `pattern: await auth\(\)` appearing **before** the Origin allowlist `.has(` call in `src/app/api/extension/bridge-code/route.ts` (line-order grep, full path anchored) — reason: refactor that prioritises session-first ordering re-opens DB-load DoS on un-allowlisted callers.
  - `pattern: credentials:\s*["']include["']` in `extension/src/background/` outside the `startConnect` function (Round-3 S22) — reason: only bridge-code POST should send cookies; other SW fetches must stay `credentials:"omit"`.
- **Acceptance criteria**:
  - Body `{}` + DPoP + cookie + Origin → 201 with `extension_bridge_codes.cnf_jkt = verifier-returned jkt`.
  - Body `{ cnfJkt: "attacker..." }` + valid DPoP + cookie + Origin → 400 (strict reject).
  - Body `{}` + DPoP + cookie + **wrong Origin** → 403.
  - Body `{}` + DPoP + **no cookie** → 401.
  - Body `{}` + **no DPoP header** → 401.
  - Body `{}` + valid DPoP + cookie + Origin + missing `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` → 403 (fail-closed).

### C5 — `POST /api/extension/token/exchange` SELECT-then-CAS pattern

- **Signature**: existing handler reordered.
- **Invariants**:
  - **Order**: `findUnique` → `verifyDpopProof(..., expectedCnfJkt: consumed.cnfJkt)` → `updateMany({ where: { codeHash, usedAt: null, cnfJkt: consumed.cnfJkt }, data: { usedAt: now }})`.
  - The `cnfJkt` value in `updateMany.where` is `consumed.cnfJkt` (loaded by `findUnique`), NOT `dpopResult.jkt` — the verifier already enforced `dpopResult.jkt === consumed.cnfJkt` via `expectedCnfJkt`. The predicate in `updateMany.where` is defense-in-depth TOCTOU guard.
  - Race-lost (CAS `count === 0`) returns `unauthorized()` with audit reason `unknown_or_consumed` (reuses existing reason — no new audit code).
  - Failure of DPoP verify returns 401 and **does NOT mutate** `extension_bridge_codes`.
  - `ExchangeRequestSchema` adds `.strict()`.
  - Token issuance (post-CAS) passes `consumed.cnfJkt` to `issueExtensionToken({cnfJkt: ...})` — this is the existing chain bridge-code.cnfJkt → token.cnfJkt that future DPoP-validated requests verify against.
- **Forbidden patterns**:
  - `pattern: \.update\(\{[\s\S]*where:\s*\{[\s\S]*codeHash` — reason: `update()` uses unique-key matching, not CAS. MUST use `updateMany` with `usedAt: null` predicate.
  - Order check: in the diff for `exchange/route.ts`, `updateMany.*usedAt: null` must appear **after** `verifyDpopProof(`.
- **Acceptance criteria**:
  - Integration (DoS hardening): invalid DPoP → 401 → `SELECT used_at FROM extension_bridge_codes WHERE id=…` returns NULL → subsequent valid DPoP → 201.
  - Integration (race): use the existing `raceTwoClients` helper at `src/__tests__/db-integration/helpers.ts:297` with two distinct `PrismaWithPool` instances. **N=50 iteration loop** (mirrors the existing `mcp-token-rotation-race.adversarial.integration.test.ts` pattern at `src/__tests__/db-integration/adversarial/mcp-token-rotation-race.adversarial.integration.test.ts:186-307`). For each iteration: seed a fresh bridge-code row, fire two valid concurrent exchanges, count outcomes. Lower-bound RT4 guards: `expect(successes).toBeGreaterThan(0)` AND `expect(losses).toBeGreaterThan(0)` AND `expect(bothSucceeded).toBe(0)`. `expect(bothFailed).toBeLessThan(N)` (NOT `=== 0`, per Round-3 T22): pg row-lock can serialize both updates under load; a few iterations may legitimately report both-failed without the CAS itself being broken — as long as `successes > 0` proves the race window opened. `Promise.all` against a single Prisma client is **insufficient** (serializes on one pg connection) and is forbidden for this test.

### C6 — Extension SW `EXT_MSG.START_CONNECT` handler

- **Signature** (`extension/src/background/index.ts`):
  ```ts
  case EXT_MSG.START_CONNECT: {
    // Validate sender belongs to this extension (defense-in-depth against
    // future onMessageExternal additions; today onMessage from external
    // extensions goes to onMessageExternal, but pin the assumption explicitly).
    if (sender.id !== chrome.runtime.id) return;
    const result = await startConnect();
    sendResponse(result);                                   // { ok, errorCode? }
    return;
  }
  ```
  Where `startConnect()` performs:
  1. `getValidServerUrl()` — settings.
  2. `signDpopProof({ route: EXT_API_PATH.EXTENSION_BRIDGE_CODE, method: "POST", serverUrl })` — no accessToken, no ath.
  3. `fetch(serverUrl + EXT_API_PATH.EXTENSION_BRIDGE_CODE, { method:"POST", credentials:"include", headers:{ "Content-Type":"application/json", "DPoP":proof }, body:"{}" })` — note `credentials:"include"`.
  4. On non-ok: map `errorCode = body.error || "GENERIC_FAILURE"`; return.
  5. On 201: parse code, sign exchange DPoP, fetch exchange (`credentials:"omit"` per existing pattern), `setToken(token, expiresAt, cnfJkt)`.
- **Invariants**:
  - The bridge-code fetch is the **only** SW fetch that uses `credentials:"include"`.
  - DPoP signer never sees the access token (none exists yet).
  - On any failure, `currentToken` is unchanged (no partial state). `setToken` runs only after both fetches succeed.
- **Forbidden patterns**:
  - `pattern: swFetchAuthenticated\(EXT_API_PATH\.EXTENSION_BRIDGE_CODE` — reason: existing helper hardcodes `credentials:"omit"` and adds Bearer (we have none).
- **Acceptance criteria**:
  - 5 unit tests in `background.test.ts`:
    1. Happy path → SET_TOKEN issued.
    2. Bridge-code 401 → no token; errorCode propagated.
    3. Exchange 401 → no token; errorCode propagated.
    4. Network error mid-flow → no token; errorCode = GENERIC_FAILURE.
    5. DPoP signer throws (e.g., IDB unavailable) → returns errorCode = GENERIC_FAILURE.

### C7 — Extension content script `EXT_CONNECT_REQUEST` handler

- **Signature** (`extension/src/content/token-bridge-lib.ts` + `token-bridge.js`):
  - On `EXT_CONNECT_REQUEST_MSG_TYPE` postMessage from window:
    1. Validate `event.source === window && event.origin === window.location.origin`.
    2. Validate `event.data.reqId` is a non-empty string.
    3. Forward to SW via `chrome.runtime.sendMessage({ type: EXT_MSG.START_CONNECT })`.
    4. Post back `{ type: EXT_CONNECT_READY_MSG_TYPE, reqId, ok: boolean, errorCode?: string }`.
  - **Remove**: `handleBridgeCodeMessage`, `handleJktRequestMessage` (legacy paths).
- **Invariants**:
  - **Parallel impl**: both `token-bridge-lib.ts` (test) AND `token-bridge.js` (prod) MUST be updated identically. `token-bridge-js-sync.test.ts` (existing) enforces.
  - Content script does NOT receive or relay any DPoP key material, cnfJkt, bridge code, or token.
- **Forbidden patterns**:
  - `pattern: handleBridgeCodeMessage` — reason: removed.
  - `pattern: handleJktRequestMessage` — reason: removed.
  - `pattern: EXT_JKT_REQUEST_MSG_TYPE` — reason: type constant removed.

### C8 — Proxy `proxy.test.ts` cases

- **Invariants**:
  - cookie + Origin: chrome-extension://<id-IN-ALLOWLIST> + POST /api/extension/bridge-code → passes through to route handler (status from handler, NOT 403)
  - cookie + Origin: chrome-extension://<id-NOT-IN-ALLOWLIST> + POST /api/extension/bridge-code → 403 from route handler (Origin check is in route, not proxy)
  - cookie + Origin: https://attacker.example + POST /api/extension/bridge-code → 403 from route handler
  - NO cookie + Origin: chrome-extension://<id-IN-ALLOWLIST> + POST /api/extension/bridge-code → reaches route handler, then 401 (no session)
- **Acceptance criteria**: see Tests section.

### C9 — Web App `requestExtensionConnect()` helper

- **Signature** (`src/lib/extension-connect-request.ts`, new file):
  ```ts
  export type ExtensionConnectResult =
    | { ok: true }
    | { ok: false; errorCode: ExtensionConnectErrorCode };

  export type ExtensionConnectErrorCode =
    | "EXTENSION_ABSENT"
    | "SESSION_STEP_UP_REQUIRED"
    | "GENERIC_FAILURE";

  export async function requestExtensionConnect(): Promise<ExtensionConnectResult>;
  ```
- **Invariants**:
  - Sends `EXT_CONNECT_REQUEST` postMessage with reqId, awaits matching `EXT_CONNECT_READY` (timeout 8s).
  - Timeout rationale: SW cold-start (~1s) + DPoP key gen on cold IDB (~200ms) + two network RTTs (bridge-code POST + exchange POST, ~2s each on slow networks) + per-fetch DB writes (~500ms each) + safety margin. Old `requestExtensionJkt` 500ms was OK for a single postMessage round-trip but is too tight for the new SW-initiated dual-fetch flow.
  - Validates the response's `errorCode` against the union — unknown codes coerced to `"GENERIC_FAILURE"`.
  - `EXT_CONNECT_PARAM` (`ext_connect=1` query) continues to be the trigger; only the connect mechanism changes (postMessage payload → SW-initiated fetch).
- **Acceptance criteria**:
  - Consumed in `src/components/extension/auto-extension-connect.tsx`.
  - `requiresReauth` UI branch fires on `errorCode === "SESSION_STEP_UP_REQUIRED"`.
  - `requiresExtensionUpdate` UI branch fires on `errorCode === "EXTENSION_ABSENT"` (no `EXT_CONNECT_READY` within timeout).

### C10 — EXT_MSG / message type unions / API paths sync

- **Files**:
  - `extension/src/lib/constants.ts`: add `EXT_MSG.START_CONNECT`, `EXT_CONNECT_REQUEST_MSG_TYPE`, `EXT_CONNECT_READY_MSG_TYPE`. **Remove** `EXT_JKT_REQUEST_MSG_TYPE`, `EXT_JKT_READY_MSG_TYPE`, `BRIDGE_CODE_MSG_TYPE`.
  - `extension/src/lib/api-paths.ts`: add `EXTENSION_BRIDGE_CODE: "/api/extension/bridge-code"`. Mirror of `API_PATH.EXTENSION_BRIDGE_CODE` already in `src/lib/constants/auth/api-path.ts:8`.
  - `extension/src/types/messages.ts`: extend `ExtensionMessage` + `ExtensionResponse` discriminated unions for `START_CONNECT`. Remove discriminated branches for removed message types.
  - `src/lib/constants/integrations/extension.ts`: add `EXT_CONNECT_REQUEST_MSG_TYPE`, `EXT_CONNECT_READY_MSG_TYPE`. Remove old constants.
- **Acceptance criteria**: `src/__tests__/i18n/extension-constants-sync.test.ts` passes after all four files updated atomically.

### C11 — Dead code cleanup (atomic with this PR)

- **Delete**:
  - `src/lib/extension-jkt-request.ts` (replaced by C9)
  - `src/lib/inject-extension-bridge-code.ts` (Web App no longer issues codes)
  - `src/__tests__/lib/extension-jkt-request.test.ts` (covers deleted module)
  - `src/lib/inject-extension-bridge-code.test.ts` (covers deleted module — colocated test file)
  - Legacy comment in `src/app/api/extension/token/exchange/route.ts:17-21` updated to cross-reference C2 (bridge-code now requires Origin).

### C12 — Tests (consolidated)

| Test file | Action |
|---|---|
| `src/__tests__/api/extension/bridge-code-cnfJkt.test.ts` | **Rewrite**: 6 existing cases → new cases asserting body schema strict, DPoP-derived cnf_jkt, Origin allowlist enforcement, fail-closed on missing env. |
| `src/app/api/extension/bridge-code/route.test.ts` | Update for new auth order (Origin → DPoP → cookie). |
| `src/app/api/extension/token/exchange/route.test.ts` | Add `.strict()` schema test; assert `updateMany` NOT called on invalid DPoP (call-count, complemented by integration). |
| `src/__tests__/api/extension/token-exchange-dpop.test.ts` | Extend for SELECT-then-CAS reordering. |
| `src/__tests__/db-integration/extension-token-dpop-flow.integration.test.ts` | **New cases**: (a) invalid-DPoP-doesn't-consume — assert `SELECT used_at IS NULL` after fail. (b) Concurrent valid exchanges — `Promise.all([POST(req1), POST(req2)])` against real DB; assert exactly-one-201 AND exactly-one-401 AND exactly-one-new-token-row, **with RT4 lower-bound assertions** (`expect(successes).toBeGreaterThan(0)` AND `expect(failures).toBeGreaterThan(0)`). |
| `src/__tests__/proxy.test.ts` | C8 cases. |
| `src/__tests__/lib/http/cors-dpop-header.test.ts` | C3 cases. |
| `src/lib/env-schema.test.ts` | C1 regex acceptance/rejection cases. |
| `e2e/tests/extension-token-dpop.spec.ts` | Drop body-cnfJkt assertion; add Origin assertion; assert NO postMessage carrying cnfJkt is observable from page side. |
| `extension/src/__tests__/background.test.ts` | C6 5 cases. |
| `extension/src/__tests__/content/token-bridge.test.ts` | Drop legacy handler tests; add EXT_CONNECT_REQUEST tests. |
| `extension/src/__tests__/content/token-bridge-js-sync.test.ts` | Update for new handlers. |
| `src/components/extension/auto-extension-connect.test.tsx` | **Rewrite**: drop bridge-code fetch assertions; assert calls into `requestExtensionConnect()`. |
| `src/__tests__/i18n/extension-constants-sync.test.ts` | Re-verify with new constants + new API path. |
| **Delete**: `src/__tests__/lib/extension-jkt-request.test.ts` | covers deleted module. |
| **Delete**: `src/lib/inject-extension-bridge-code.test.ts` | covers deleted module. |
| Test-time allowlist Set reset helper | Add `__resetAllowlistForTests()` (test-only export) in the module that builds the Set; tests that mutate `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` between cases call this helper or use `vi.resetModules()` + dynamic re-import. |
| E2E negative-postMessage assertion specificity | The "no observable cnfJkt postMessage" assertion in `extension-token-dpop.spec.ts` MUST install a `window.postMessage` spy BEFORE the connect flow starts (via `page.evaluate(() => { const orig = window.postMessage; (window as any).__msgs = []; window.postMessage = (data, target) => { (window as any).__msgs.push(data); return orig(data, target); }; })`), then after connect completes assert `(await page.evaluate(() => (window as any).__msgs)).every(m => !("cnfJkt" in m))`. |

### C13 — Manual test plan (R35 Tier-2)

- **File**: `docs/archive/review/extension-jkt-trust-path-manual-test.md` (new).
- **Sections**: Pre-conditions / Steps / Expected result / Rollback / Adversarial scenarios.
- **Adversarial scenarios** (mandatory):
  1. DevTools console: `window.postMessage({type:"PASSWD_SSO_EXT_CONNECT_REQUEST", reqId:"x"}, "*")` (no real user click) — observe SW signs DPoP with its own IDB key. Verification mechanism (DevTools cannot call `chrome.runtime.sendMessage({type:"GET_DPOP_JKT"})` from page context — it's a content-script-only relay). Use the **server-side DB read** as the source of truth: `docker compose exec db psql -U passwd_user -d passwd_sso -c "SELECT cnf_jkt FROM extension_bridge_codes ORDER BY created_at DESC LIMIT 1;"` and compare to the SW's persisted jkt. The SW exposes its cnfJkt via `chrome.storage.session` — the exact key name comes from `extension/src/lib/session-storage.ts` schema (Round-3 T23: check the current value of the `tokenCnfJkt` field; if `session-storage.ts` renames it later, update this manual-test step). Inspect via `chrome://extensions` → SW Inspect → Application → Storage → Session. Both must match the same 43-char base64url string.
  2. Modify `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` to wrong ID, retry connect → expect 403. Distinguish from CSRF-gate 403 by checking response body's `error` code (route handler returns `INVALID_ORIGIN_EXTENSION`; CSRF gate returns `INVALID_ORIGIN`).
  3. Stolen-bridge-code from packet capture: `curl -H "DPoP: <attacker-signed>" -X POST /api/extension/token/exchange -d '{"code":"<stolen>"}'` → expect 401 AND `extension_bridge_codes.used_at` still NULL.
  4. Unset env var entirely, retry connect → expect 403 (fail-closed).
  5. Browser restart mid-flow (after bridge-code success, before exchange) → no orphan token; user can retry.

### C14 — Audit-event coverage for new failure modes (deferred)

- **Decision**: defer adding `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` audit action to a follow-up PR. Rationale: existing rate-limiter + structured pino logs (already in place at `src/lib/logger`) provide adequate observability for anomaly detection. Adding a new AUDIT_ACTION here would require: enum addition, AUDIT_ACTION_GROUP membership update, i18n labels (en + ja), UI label maps, sync test updates — out of scope for the security-fix PR.
- **Tracked as**: `TODO(extension-jkt-trust-path-followup): add EXTENSION_BRIDGE_CODE_ISSUE_FAILURE audit emission for Origin-allowlist-miss / env-unset / DPoP-fail paths`.
- **Acceptance criteria**: pino warn log fires on each failure mode (visible in dev server output). Verified manually in C13 adversarial scenarios.

### C15 — Residual XSS-triggers-silent-connect — follow-up tracking

- **Decision**: residual is classified as XSS-acts-as-user equivalent (out of scope; same as PR #491). Token is bound to extension's non-extractable key — attacker cannot exfiltrate. Defense-in-depth via `userActivation.isActive` gating on content-script's `EXT_CONNECT_REQUEST` handler deferred.
- **Tracked as**: `TODO(extension-jkt-trust-path-followup): add userActivation.isActive gating on EXT_CONNECT_REQUEST to close silent-connect path`.
- Documented in §Threat model and §Non-goals.

## Consumer-flow walkthroughs

### Walkthrough for C4 (`POST /api/extension/bridge-code`) response shape

The 201 response body `{ code: string<64 hex>, expiresAt: ISO8601 }` is consumed by:

- **Consumer 1** (path: `extension/src/background/index.ts`, in `startConnect()`):
  - Reads `{ code, expiresAt }`.
  - Uses `code` to construct the exchange POST body.
  - Uses `expiresAt` for logging / debugging only.
  - No URL construction needed; `expiresAt` is informational.

### Walkthrough for the cnf_jkt persistence chain (cross-contract)

The `cnf_jkt` value flows across multiple persistence boundaries. Operations at each consumer:

- **Producer**: `verifyDpopProof()` in C4 — returns `result.jkt` derived from the proof's verified `jwk` header.
- **Consumer 1** (path: `bridge_code` table column `cnf_jkt`): C4 writes `result.jkt` into `extension_bridge_codes.cnf_jkt`. This is the canonical bind point — every downstream consumer reads from here, not from the original request headers.
- **Consumer 2** (path: `src/app/api/extension/token/exchange/route.ts:findUnique`): C5 reads `consumed.cnfJkt` from this column and passes it as `expectedCnfJkt` to `verifyDpopProof()`. This locks in the bridge-code→exchange chain.
- **Consumer 3** (path: `extension_tokens` table column `cnf_jkt`): C5 passes `consumed.cnfJkt` (NOT `dpopResult.jkt`) into `issueExtensionToken({cnfJkt: ...})` for token-row persistence. The semantic invariant is: bridge_code.cnf_jkt → token.cnf_jkt → future-DPoP-verify all read the SAME thumbprint, established once at C4 and never rewritten.
- **Consumer 4** (path: `validateExtensionToken()` in `src/lib/auth/tokens/extension-token.ts`): later, every authenticated API call reads `token.cnf_jkt` and passes it as `expectedCnfJkt` to verify the request's DPoP proof. Same chain.

### Walkthrough for C9 (`requestExtensionConnect()` result shape)

`{ ok: boolean, errorCode?: ExtensionConnectErrorCode }` is consumed by:

- **Consumer 1** (path: `src/components/extension/auto-extension-connect.tsx`):
  - Reads `{ ok, errorCode }`.
  - On `ok: true` → sets `connected = true`, no further UI.
  - On `ok: false, errorCode: "SESSION_STEP_UP_REQUIRED"` → renders reauth CTA (existing branch).
  - On `ok: false, errorCode: "EXTENSION_ABSENT"` → renders "install extension" CTA.
  - On `ok: false, errorCode: "GENERIC_FAILURE"` → renders generic failure message with retry button.
  - All three error branches map to existing UI components (`requiresReauth`, `requiresExtensionUpdate`, `connectFailedDescription`).

### Walkthrough for C7 (`EXT_CONNECT_READY` postMessage)

`{ type: EXT_CONNECT_READY_MSG_TYPE, reqId: string, ok: boolean, errorCode?: string }` is consumed by:

- **Consumer 1** (path: `src/lib/extension-connect-request.ts:requestExtensionConnect`):
  - Filters by `reqId === sentReqId` (prevent cross-talk).
  - Validates `errorCode` against the typed union (unknown → coerce to `"GENERIC_FAILURE"`).
  - Returns to caller.

## Implementation phases

| Phase | Scope | Tests |
|---|---|---|
| 0 — env var + schema | C1, `.env.example`, `scripts/env-descriptions.ts`, regex `[a-p]{32}` + CSV | env-schema.test.ts + check:env-docs |
| 1 — proxy + CORS | C2 (route-policy.ts), C3 (cors.ts), C8 (proxy.test.ts) | unit + proxy.test.ts |
| 2 — server-side bridge-code rewrite | C4 (route.ts with new order + empty body schema + Origin check + DPoP-derived cnfJkt) | unit + integration |
| 3 — exchange SELECT-then-CAS | C5 | unit + integration (real-DB race + DPoP-fail) |
| 4 — extension SW handler | C6 + C10 (constants + types) | extension unit |
| 5 — extension content script | C7 (both `.js` and `-lib.ts` + sync test) | extension unit |
| 6 — Web App helper + UI | C9, `auto-extension-connect.tsx` rewrite | unit + manual + E2E |
| 7 — dead code cleanup + docs | C11, `docs/architecture/extension-token-bridge.md`, comments | — |
| 8 — manual test artifact | C13 | execute manually before merge |

Each phase = its own commit; one PR.

## Migration / rollout

- **Strict day-1 lockstep**. All three artifacts (server, extension, Web App) deploy together. No deprecation window for body `cnfJkt` (eliminated immediately).
- Old extension + new server: old extension's body-`cnfJkt` request hits `z.object({}).strict()` → 400. User sees "extension update required". Tolerable transient state for the deployment minute.
- New extension + old server: new extension's empty body + Origin check is unknown to old server → old server's `BridgeCodeIssueSchema.strict()` rejects empty body → 400. Same transient state.
- Rolling deploy with the server first → some users see 400 for a few minutes until extension auto-updates from Web Store. Acceptable.

## Rollback

- If extension fails to connect for >X% of users in canary (X TBD by operator):
  - Revert server commit (single PR).
  - Web App + extension stay at v2 — they will retry, hit reverted server, and the OLD bridge-code schema doesn't recognize the new request shape either → fall-through to error state. Users see "connect failed" until server is re-deployed at the next attempt.
- Database compatibility: no schema migration in this PR (C1 only adds env var; no Prisma migration). Safe to roll back without DB changes.

## Open questions

(All Round-1 open questions resolved.)

## Non-goals

- iOS / mobile DPoP path rewrite (uses different routes).
- chrome.identity OAuth flow (Approach D — future hardening pass).
- User-activation requirement on `EXT_CONNECT_REQUEST` (deferred defense-in-depth; threat is equivalent to XSS-acts-as-user).

## Rollback (existing PENDING bridge-code rows)

Existing PENDING `extension_bridge_codes` rows from PR #491's code path may still be in DB during the deploy minute. They are still valid for exchange (DPoP verify will succeed iff the original holder of the body-supplied JKT still has the key; this is the residual XSS exposure the deploy is closing). They expire within `BRIDGE_CODE_TTL_MS` (60s). No data cleanup needed; allow natural expiry.

## Go/No-Go Gate

| ID  | Subject                                                              | Status |
|-----|----------------------------------------------------------------------|--------|
| C1  | `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` env var + zod schema         | locked |
| C2  | Route classification + orchestrator wiring                           | locked |
| C3  | CORS + Allow-Credentials guarded by routeKind + preflight wiring     | locked |
| C4  | `POST /api/extension/bridge-code` rewrite                            | locked |
| C5  | `POST /api/extension/token/exchange` SELECT-then-CAS + raceTwoClients | locked |
| C6  | Extension SW `EXT_MSG.START_CONNECT` handler + sender.id check       | locked |
| C7  | Extension content script `EXT_CONNECT_REQUEST` handler               | locked |
| C8  | Proxy `proxy.test.ts` cases (assertion distinguishes 403 source)     | locked |
| C9  | Web App `requestExtensionConnect()` helper + timeout rationale       | locked |
| C10 | EXT_MSG / message types / api-paths.ts sync                          | locked |
| C11 | Dead code cleanup (incl. .test.ts files)                             | locked |
| C12 | Tests (consolidated, incl. raceTwoClients pattern)                   | locked |
| C13 | Manual test plan with executable verification path                   | locked |
| C14 | Audit-event coverage (deferred to follow-up; TODO marker)            | locked |
| C15 | Residual XSS-triggers-silent-connect (deferred; TODO marker)         | locked |
