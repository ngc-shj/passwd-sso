# Plan: hardcoded-values-to-constants

Branch: `refactor/hardcoded-values-to-constants`
Type: refactor (behavior-preserving)

## Project context

- Type: web app (Next.js 16) + browser extension + CLI (monorepo; iOS app excluded — see SC1)
- Test infrastructure: unit + integration + E2E + CI/CD (vitest, next build, extension/cli test suites, pre-pr.sh, CI extension/integration jobs)
- Verification environment constraints:
  - VE1: real-DB integration tests require a running Postgres (`npm run test:integration`) — all contracts in this plan are pure refactors verifiable by unit tests + build (`verifiable-local`); no contract requires integration-only verification.
  - VE2: the Extension CI job and DB+Redis integration CI job are not covered by `pre-pr.sh` — extension test suite will be run locally (`verifiable-local`); CI re-verifies.
  - VE3: iOS code requires Xcode/macOS — iOS is out of scope (SC1), no contract touches it.

## Objective

Eliminate magic numbers and repeated hardcoded string literals that bypass (or should join) the existing shared-constants infrastructure (`src/lib/constants/`, `CRYPTO_CONSTANTS`, `API_ERROR`, extension `constants.ts`, cli `time.ts`), with **zero runtime behavior change**. Every replaced literal keeps its exact current value.

## Requirements

- Functional: no observable behavior change. All constant values are numerically/byte-identical before and after.
- Non-functional: single-definition for each shared value within each build boundary (src/, extension/, cli/ are separate boundaries — cross-boundary mirrors are intentional and stay, guarded by sync tests where they exist).
- Convention: 3+ enumerated string literals → const-object + derived type (AUDIT_ACTION style). Time/TTL constants computed from `MS_PER_*`/`SEC_PER_*` base constants.
- Import-boundary safety: client bundles must not import server-only modules (`common.server.ts`, `envelope.ts` which imports `node:crypto`). The new crypto params module must be dependency-free.

## Technical approach

Investigation (3 parallel codebase sweeps + fingerprint, 2026-06-13) produced a verified inventory. Fix clusters:

1. **Crypto parameter consolidation (src/)** — `IV_LENGTH = 12`, `AUTH_TAG_LENGTH = 16`, `AES_KEY_LENGTH = 256`, `PBKDF2_ITERATIONS = 600_000` are re-declared across 7 files (`crypto-client.ts`, `crypto-emergency.ts`, `crypto-team.ts`, `crypto-recovery.ts`, `export-crypto.ts`, `crypto-server.ts`, `envelope.ts` — each declares the subset it uses; all local declarations are removed). `envelope.ts` exports them but imports `node:crypto`, so browser-side files cannot import it. Solution: new **pure** module `src/lib/crypto/crypto-params.ts` (no imports at all); all crypto files import from it; `envelope.ts` re-exports from it (keeping its public surface); `CRYPTO_CONSTANTS` in `crypto-client.ts` keeps its object shape but references the shared params.
2. **Time arithmetic normalization (src/)** — inline `* 1000` / `60 * 60` / `86_400_000`-style arithmetic replaced with `MS_PER_*`/`SEC_PER_*` from `src/lib/constants/time.ts`.
3. **`RATE_WINDOW_MS` adoption** — 40 server files use literal `windowMs: 60_000` while `RATE_WINDOW_MS` exists in `common.server.ts` (already used by 2 routes). All call sites are server-side, so the server-only import constraint is satisfied.
4. **TTL/timeout dedup** — local re-definitions replaced by existing constants; genuinely-new shared values get named constants in their canonical homes.
5. **String literal constants (src/)** — token prefixes, storage keys, enumerated literals (SHARE_TYPE, ACTOR_TYPE derivation, revoke reasons), API_ERROR codes.
6. **i18n numeric-limit drift (R27)** — TenantAdmin TTL help/validation strings hardcode `86400`/`60` (JIT/delegation token lifetime = security policy boundary); switch to interpolation from `JIT_TOKEN_TTL_MAX`/`DELEGATION_TTL_MAX`. PrivacyPolicy hardcodes `600,000` PBKDF2 iterations; interpolate from the shared constant.
7. **extension/** — add `extension/src/lib/time.ts` (mirror of cli's), `GCM_TAG_LENGTH`, missing message-type constants (with plain-JS twin sync comments per existing pattern).
8. **cli/** — `GCM_TAG_LENGTH`, agent timeout constants, OAuth default expiry, API path constants.

## Contracts

> No contract changes any API response shape, persisted-state shape, message payload, or event payload — all payload/string VALUES are identical pre/post; only the source-code spelling moves from literal to constant. Consumer-flow walkthroughs are therefore N/A for every contract (no shape is created or modified).

### C1 — Pure crypto params module + adoption (src/)

- New file `src/lib/crypto/crypto-params.ts` (zero imports):
  ```
  export const AES_KEY_LENGTH = 256
  export const IV_LENGTH = 12
  export const AUTH_TAG_LENGTH = 16
  export const PBKDF2_ITERATIONS = 600_000
  ```
- `src/lib/crypto/envelope.ts`: drop local `IV_LENGTH`/`AUTH_TAG_LENGTH` definitions, re-export from crypto-params (public surface unchanged: `ALGORITHM`, `IV_LENGTH`, `AUTH_TAG_LENGTH`, `SENTINEL` stay exported).
- `crypto-client.ts`, `crypto-emergency.ts`, `crypto-team.ts`, `crypto-recovery.ts`, `export-crypto.ts`, `crypto-server.ts`: delete local re-declarations, import from crypto-params. `CRYPTO_CONSTANTS` object shape in `crypto-client.ts` unchanged (values now referenced).
- All authTag slice sites (`encryptedBytes.length - 16`, 8 pairs / 16 lines: crypto-client ×3, crypto-team ×2, export-crypto ×1, crypto-emergency ×1, crypto-recovery ×1) use `AUTH_TAG_LENGTH`.
- `crypto-recovery.ts:170` bare `{ name: "AES-GCM", length: 256 }` → `AES_KEY_LENGTH` (genuine AES-GCM key length; the site never declared a local constant, so re-declaration greps alone would miss it).
- `crypto-recovery.ts:~278` `deriveBits(..., 256)` — this 256 is HKDF **verifier** output bits (fed to SHA-256, not an AES key). Do NOT label it `AES_KEY_LENGTH`; introduce a file-local `VERIFIER_BITS = 256` (naming precedent: `VERIFIER_PBKDF2_BITS = 256` in `crypto-client.ts:23`) with a one-line comment that the value coincides with AES_KEY_LENGTH but is semantically distinct.
- `src/app/api/vault/setup/route.ts:118` fallback `?? 600_000` → `?? PBKDF2_ITERATIONS` from crypto-params (third definition of the PBKDF2 default, outside `src/lib/crypto/`).
- `crypto-client.ts:169` Argon2 fallback `?? 65536` → `?? ARGON2ID_KDF_PARAMS.kdfMemory` (same file, existing object).
- Invariants:
  - (app-enforced, test-guarded) golden-vector parity tests pass unchanged — proves byte-identical crypto behavior. Schema-enforced equivalent does not exist for in-code constants; the golden-vector suite is the strongest available guard.
  - (build-enforced) `crypto-params.ts` has no import statements → safe in both client and server bundles; `next build` fails if a server-only module leaks into client.
- Forbidden patterns:
  - pattern: `600_000` in src/ outside `crypto-params.ts` — reason: PBKDF2 iteration re-declaration. Named exclusions (semantically distinct values, do NOT fold in): `src/lib/validations/common.server.ts` `KDF_PBKDF2_ITERATIONS_MIN` (minimum guard, not the default); `src/lib/prisma.ts` `max: envInt("DB_POOL_MAX", 20, {max: 200})` (connection COUNT — NOTE: the pool's ms timeout values were initially mis-excluded here as "unrelated"; they ARE time values and were normalized under C14, see deviation D8); `src/lib/crypto/crypto-client.ts:22` `VERIFIER_PBKDF2_ITERATIONS` (passphrase-verifier iteration count, exported via CRYPTO_CONSTANTS, mirrored by `cli/src/lib/crypto.ts:17` — same value today by coincidence of policy, separate knob by design)
  - pattern: `IV_LENGTH = 12` outside `src/lib/crypto/crypto-params.ts` (src/ scope) — reason: per-file re-declaration
  - pattern: `\.length - 16` in `src/lib/crypto/*.ts` — reason: magic authTag length
  - pattern: `length: 256` in `src/lib/crypto/crypto-recovery.ts` — reason: bare key-length literal with no local constant (escapes re-declaration greps). Companion check for the deriveBits site (the `length:` pattern cannot match it): after the edit, `grep -n 'deriveBits' src/lib/crypto/crypto-recovery.ts` must show `VERIFIER_BITS`, not a bare `256`
- Acceptance: greps above return 0 in src/ (minus named exclusions); value-pin assertions added to `e2e/helpers/crypto.test.ts` importing directly from crypto-params: `expect(AUTH_TAG_LENGTH).toBe(16)`, `expect(AES_KEY_LENGTH).toBe(256)` (PBKDF2_ITERATIONS and IV_LENGTH are already pinned there via CRYPTO_CONSTANTS — keep those assertions working by preserving the object shape); `npx vitest run` (incl. golden vectors) passes; `npx next build` passes.

### C2 — Time arithmetic normalization (src/)

Replace inline ms arithmetic with `MS_PER_*`/`SEC_PER_*` imports at these verified sites (values unchanged):
- `src/lib/auth/tokens/mobile-token.ts:35-36` → `MS_PER_DAY`, `7 * MS_PER_DAY`
- `src/lib/security/rate-limit-audit.ts:42` → `5 * MS_PER_MINUTE`
- `src/lib/security/rate-limiters.ts:22` → `15 * MS_PER_MINUTE` (file already imports `MS_PER_MINUTE`)
- `src/workers/audit-outbox-worker.ts:869-870` → `MS_PER_HOUR`, `MS_PER_DAY`
- `src/components/watchtower/auto-monitor-toggle.tsx:15-16` → `MS_PER_MINUTE`, `MS_PER_HOUR`
- `src/components/emergency-access/grant-card.tsx:140-141` → `MS_PER_DAY`, `MS_PER_HOUR`
- `src/components/settings/developer/service-account-card.tsx:1001` → `MS_PER_DAY`
- `src/lib/audit/anchor-destinations/s3-destination.ts:40` → `this.retentionYears * 365 * MS_PER_DAY`
- `src/lib/http/backoff.ts:6` → `MS_PER_HOUR`
- MCP sec→ms conversions: `src/lib/mcp/oauth-server.ts` (5 sites), `src/app/api/mcp/register/route.ts:134` → `* MS_PER_SECOND` (no new `_MS` twin constants; the `_SEC` constant is the SSoT and `* MS_PER_SECOND` keeps unit conversion explicit)
- Invariant (app-enforced): `src/lib/constants/time.ts` values unchanged; all replacements are arithmetic identities.
- Forbidden patterns:
  - pattern: `60 \* 60 \* 1000|1000 \* 60 \* 60` in src/ non-test files — reason: inline hour/day arithmetic
  - pattern: `\b(86400000|86_400_000|3600000|3_600_000)\b` in src/ non-test, non-`time.ts` files — reason: raw day/hour ms (env-schema handled by C5)
- Acceptance: greps return 0 (excluding tests and `time.ts`); vitest + build pass.

### C3 — RATE_WINDOW_MS adoption (40 server files)

- Every `windowMs: 60_000` (40 files: API routes + `src/lib/mcp/server.ts` + `src/lib/scim/rate-limit.ts`) → `windowMs: RATE_WINDOW_MS` imported from `@/lib/validations/common.server`.
- `src/lib/security/rate-limiters.ts` `v1ApiKeyLimiter`: `windowMs: MS_PER_MINUTE` → `windowMs: RATE_WINDOW_MS` (same value; domain-naming consistency so future limiters copy the right convention). The 15-minute `migrateLimiter` window stays `15 * MS_PER_MINUTE` (deliberately different window — NOT folded into RATE_WINDOW_MS; handled under C2).
- All call sites verified server-side (routes/lib/server) — the server-only import constraint of `common.server.ts` holds. Pre-verified 2026-06-13: `src/lib/mcp/server.ts` is imported only by `src/app/api/mcp/route.ts`; `src/lib/scim/rate-limit.ts` only by `src/lib/scim/with-scim-auth.ts`; no `.tsx` consumer exists. `npx next build` is the structural backstop for any missed client leak.
- Per-route `max`/threshold values stay as-is: they are deliberately route-specific tuning (different values per route), not duplicated constants (see SC4).
- Invariant (app-enforced): `RATE_WINDOW_MS = 60_000` value unchanged; per-route `max` values untouched.
- Forbidden pattern: `windowMs: 60_?000` — reason: bypasses RATE_WINDOW_MS
- Acceptance: `grep -rn "windowMs: 60_000\|windowMs: 60000" src/` → 0; `grep -n "windowMs: MS_PER_MINUTE" src/lib/security/rate-limiters.ts` → 0 (the v1ApiKeyLimiter conversion is invisible to the literal grep — this companion grep catches it); vitest + build pass.

### C4 — TTL/timeout constant dedup (src/)

- `src/app/api/tenant/access-requests/[id]/approve/route.ts`: local `DEFAULT_JIT_TTL_SEC = 3600` → `SEC_PER_HOUR`; local `MAX_JIT_TTL_SEC = 86400` deleted, import `JIT_TOKEN_TTL_MAX` (`@/lib/validations/common`); `ttlSec * 1000` → `* MS_PER_SECOND`.
- `src/app/api/tenant/members/[userId]/reset-vault/route.ts:34`: local `RESET_TOKEN_TTL_MS` deleted, import `RESET_TOTAL_TTL_MS` from `@/lib/constants/time` (same value `MS_PER_DAY`; constant already exists for exactly this flow).
- Watchtower cooldown: single `WATCHTOWER_COOLDOWN_MS = 5 * MS_PER_MINUTE` in `src/lib/constants/timing.ts`. Explicit migration: the route's local `WATCHTOWER_SCAN_COOLDOWN_MS` (`watchtower/start/route.ts:10`) is a DIFFERENT identifier — delete the local declaration AND rename its usage sites in that file to the shared `WATCHTOWER_COOLDOWN_MS`; delete the duplicate `export const WATCHTOWER_COOLDOWN_MS` from `use-watchtower.ts:31` and import from timing.ts instead (update any importers of the hook's export). timing.ts stays client-safe (no server-only imports added).
- Invitation TTLs: `TEAM_INVITATION_TTL_MS = 7 * MS_PER_DAY` in `src/lib/constants/team/` (existing dir) used by `teams/[teamId]/invitations/route.ts:131`; `EMERGENCY_ACCESS_INVITE_TTL_MS = 7 * MS_PER_DAY` in a constants home for emergency access, used by `emergency-access/route.ts:60`. Two separate constants — same value today but independent policies.
- Prisma tx timeouts: `VAULT_ROTATE_TX_TIMEOUT_MS = 120_000` and `TEAM_ROTATE_TX_TIMEOUT_MS = 60_000` in `src/lib/constants/vault/` and `src/lib/constants/team/` respectively; adopted by the two rotate-key routes.
- Worker pool: `WORKER_POOL_IDLE_TIMEOUT_MS = 30_000`, `WORKER_POOL_STATEMENT_TIMEOUT_MS = 60_000` in a new shared `src/workers/worker-pool-config.ts` (workers are a separate runtime entry; keeping it under src/workers avoids dragging constants/index into worker bundles), adopted by `audit-outbox-worker.ts`, `dcr-cleanup-worker.ts`, `audit-anchor-publisher.ts`.
- All new TTL constants computed from `MS_PER_*`/`SEC_PER_*` or named with explicit `_MS` suffix.
- Acceptance: each listed file imports the named constant; no local duplicate remains; vitest + build pass.

### C5 — env-schema.ts bounds from time constants

- `src/lib/env-schema.ts` Zod bounds replaced by identity expressions: `.max(86_400_000)` → `MS_PER_DAY`, `.default(3_600_000)`/`.max(3600000)` → `MS_PER_HOUR`, `.max(86400)` → `SEC_PER_DAY`, `.max(600000)` → `10 * MS_PER_MINUTE`, `.max(300000)` → `5 * MS_PER_MINUTE` (lines 88-89, 265, 296, 311, 317, 372, 378, 384).
- `time.ts` is import-free → safe for env-schema's early-load context (it currently imports only `zod` and `validations/common`).
- Post-check: `npm run check:env-docs` (drift check `.env.example` ↔ env-schema) passes — generated docs must not change since values are identical.
- Acceptance: vitest + build + `check:env-docs` pass.

### C6 — Token prefix bypass fixes

- `src/app/api/tenant/mcp-clients/route.ts:152`: `"mcpc_" + ...` → `MCP_CLIENT_ID_PREFIX + ...` (as `register/route.ts` already does).
- `src/lib/auth/session/auth-or-token.ts:19`: `"scim_"` in `KNOWN_PREFIXES` → `SCIM_TOKEN_PREFIX` from `@/lib/scim/token-utils` (verify no import cycle; token-utils is a leaf util).
- Forbidden patterns:
  - pattern: `"mcpc_"` outside `src/lib/constants/` — reason: bypasses MCP_CLIENT_ID_PREFIX
  - pattern: `"scim_"` outside `src/lib/scim/token-utils.ts` — reason: bypasses SCIM_TOKEN_PREFIX
- Acceptance: greps return 0 in src/ production code; vitest passes.

### C7 — Web storage key constants

- Extend `src/lib/constants/vault/storage-key.ts` (existing `LOCAL_STORAGE_KEY` pattern) with a `SESSION_STORAGE_KEY` const-object:
  - `WEBAUTHN_SIGNIN: "psso:webauthn-signin"` — adopt in `passkey-signin-button.tsx:99`, `security-key-signin-form.tsx:105`, `vault-lock-screen.tsx:151,161`
  - `SHARE_ACCESS_PREFIX: "share-access:"` — adopt in `share-password-gate.tsx:71`, `share-protected-content.tsx:69,77`
- Add to `LOCAL_STORAGE_KEY`: `RECOVERY_KEY_BANNER_DISMISSED: "psso:recovery-key-banner-dismissed"` — adopt in `recovery-key-banner.tsx:12` (delete local `DISMISS_KEY`), `recovery-key-dialog.tsx:169`.
- Invariant (app-enforced): key string values unchanged — existing users' stored flags remain readable (persist/hydrate symmetry preserved trivially because values are identical; R25 satisfied by value-identity).
- Acceptance: raw literals gone from components (grep); vitest passes.

### C8 — Enumerated string literal const-objects

- `SHARE_TYPE` adoption: replace raw `"TEXT"`/`"FILE"`/`"ENTRY_SHARE"` comparisons/assignments with `SHARE_TYPE.*` at the verified sites (`api/sends/route.ts:68`, `api/sends/file/route.ts:152`, `api/share-links/mine/route.ts:58`, `api/share-links/[id]/content/route.ts:116`, `api/share-links/[id]/route.ts:62`, `app/s/[token]/page.tsx:180`, `dashboard/share-links/page.tsx` (4 sites), `share-protected-content.tsx:125,140`). The constant `satisfies Record<ShareType, ShareType>` already.
- `VALID_ACTOR_TYPES` (`src/lib/audit/audit-query.ts:11`): derive from `ACTOR_TYPE` (`Object.values(ACTOR_TYPE)`) — membership verified identical (5 values incl. ANONYMOUS). Also re-export `ACTOR_TYPE` from `src/lib/constants/index.ts` if not already. Note: `Object.values()` yields `ActorType[]` (mutable array), intentionally widening `parseActorType`'s return-type expression from a readonly-tuple index — Prisma/callers/`it.each` all compatible; do NOT attempt `as const` on the `Object.values()` result (unsupported).
- `EXTENSION_TOKEN_REVOKE_REASON` const-object companion for the existing `ExtensionTokenFamilyRevokeReason` union in `src/lib/auth/tokens/extension-token.ts` (type derived from const-object; union spelling unchanged). Adopt at: `api/auth/passkey/verify/route.ts:183`, `api/sessions/route.ts:155`, `api/extension/token/refresh/route.ts:103`, `lib/auth/tokens/mobile-token.ts:412,430`.
- Invariant (type-enforced): derived types make a typo a compile error; values byte-identical (DB/API values unchanged).
- Acceptance: raw literals gone at listed sites; vitest + build pass.

### C9 — API_ERROR code adoption

Replace raw error-code strings with `API_ERROR.*` (values identical; pattern of throw-message matching is kept as-is — no typed-error redesign in this PR, see SC2):
- `"USER_NOT_FOUND"`: `webauthn/register/verify/route.ts:207`, `passwords/[id]/attachments/route.ts:280,322`, `attachments/[attachmentId]/migrate/route.ts:145,184`, `lib/auth/session/auth-adapter.ts:39`
- `"NOT_FOUND"`: `lib/vault/rotate-key-server.ts:487,523`, `lib/auth/webauthn/webauthn-server.ts:462`, `api/auth/passkey/reauth/verify/route.ts:98`, `migrate/route.ts:184`
- `"INVALID_PASSPHRASE"`: `hooks/use-travel-mode.tsx:85`, `rotate-key-dialog.tsx:89`, `recovery-key-dialog.tsx:145`, `change-passphrase-dialog.tsx:80`, `travel-mode-card.tsx:73`
- `"FORBIDDEN_CROSS_TENANT"` / `"FORBIDDEN_SELF_APPROVAL"` in audit `cause` fields: `admin/rotate-master-key/[rotationId]/{revoke:103,execute:94,approve:109,125}`, `tenant/members/[userId]/reset-vault/[resetId]/approve/route.ts:123`
- Precondition (verify before edit): each literal exists in `API_ERROR` with the exact same string value; if a code is missing from `API_ERROR`, add it there (value = current literal) rather than inventing a new value.
- Note: `API_ERROR` import must be client-safe for the component sites (verified: `api-error-codes.ts` has zero imports).
- Test alignment (same commit): update test assertions and helpers that hardcode these codes to `API_ERROR.*` — `src/__tests__/api/passwords/history.test.ts`, `history-restore.test.ts`, `src/__tests__/api/teams/team-history-restore.test.ts`, `src/__tests__/api/share-links/delete.test.ts`, `src/__tests__/helpers/mock-team-auth.ts` (`TeamAuthError("NOT_FOUND", 404)`), plus any further hits from a diff-time grep — keeps tests on the production convention.
- Acceptance: raw literals gone at listed sites; vitest + build pass.

### C10 — i18n numeric-limit interpolation (R27)

- `messages/{en,ja}/TenantAdmin.json` — **8 keys**: `jitTokenDefaultTtlSecHelp`, `jitTokenMaxTtlSecHelp`, `jitTokenTtlValidationMax`, `jitTokenTtlValidationMin`, `delegationDefaultTtlSecHelp`, `delegationMaxTtlSecHelp`, `delegationTtlValidationMax`, `delegationTtlValidationMin` — replace hardcoded `60`/`86400` with `{min}`/`{max}` placeholders. Source constants: `JIT_TOKEN_TTL_MIN/MAX`, `DELEGATION_TTL_MIN/MAX` (`src/lib/validations/common.ts:231-234`). **Mandatory paired step**: enumerate every rendering call site of these 8 keys (verified homes: `tenant-token-policy-card.tsx`, `tenant-delegation-policy-card.tsx` — all currently call `t(key)` with NO argument object) and update each `t(...)` call to pass the constants in the same commit — a placeholder without a supplied value renders literal `{max}` (UI regression; next-intl missing-arg is NOT a compile error). Both locales updated together.
- **Automated guard (new test)**: `src/__tests__/i18n/tenant-admin-ttl-interpolation.test.ts` — for both locales, format each of the 8 TenantAdmin keys AND PrivacyPolicy `sections.security.body` via `createTranslator` (import from `next-intl` if exported there, else `use-intl/core` — next-intl's core re-export; verified ESM-compatible under this repo's Vitest 4 + Vite 7) with the real message files and the real constants, asserting (a) output contains the constant's value, (b) output contains no literal `{`/`}` residue. Catches en/ja placeholder mismatch and value drift at test time. Known property: this test guards the POST-migration state; it passes vacuously against pre-migration messages, so the acceptance greps below are the migration-time gate and MUST be run.
- `messages/{en,ja}/PrivacyPolicy.json:45`: `600,000 iterations` → `{iterations}` placeholder formatted from `PBKDF2_ITERATIONS` (crypto-params after C1) with locale number formatting. **Mandatory paired step**: the rendering site `src/app/[locale]/privacy-policy/page.tsx:74` currently renders `sections.<key>.body` via `t(...)` with no values argument — the security-section call must pass `{ iterations: PBKDF2_ITERATIONS }` in the same commit. The interpolation test (below) also covers `sections.security.body` for both locales.
- Invariant (test-enforced): the new interpolation test pins rendered output; values rendered identical for current constants.
- Acceptance: grep `86400` in `messages/` → 0; `grep '600,000' messages/` → 0; `grep -E '"(jitToken|delegation)[^"]*": "[^"]*60' messages/en/TenantAdmin.json messages/ja/TenantAdmin.json` → 0 (locale-neutral: catches the ja form `60秒以上` which phrase-based greps miss); every call site of the 8 keys + the PrivacyPolicy security section passes an argument object (grep-verified); new interpolation test passes; rendered strings unchanged (manual spot-check of the TenantAdmin policy cards and the privacy-policy page); vitest passes.

### C11 — Extension constants

- New `extension/src/lib/time.ts`: `MS_PER_SECOND`, `MS_PER_MINUTE` (mirror of cli's module; extension cannot import src/ — cross-boundary mirror is the established pattern).
- `extension/src/background/index.ts`: `REFRESH_BUFFER_MS = 2 * 60 * 1000` → `2 * MS_PER_MINUTE`; `TEAM_KEY_CACHE_TTL_MS = 5 * 60 * 1000` → `5 * MS_PER_MINUTE`; `clipboardClearSeconds * 1000` (lines 138, 798) → `* MS_PER_SECOND`.
- `GCM_TAG_LENGTH = 16` exported from `extension/src/lib/crypto.ts`; adopted by `crypto.ts:188-189` and `session-crypto.ts:61-62` (TS-to-TS import is available).
- Message-type constants added to `extension/src/lib/constants.ts` following `EXT_MSG`/twin-sync conventions: `PSSO_SHOW_SAVE_BANNER`, `PSSO_TRIGGER_INLINE_SUGGESTIONS`, `PSSO_VAULT_STATE_CHANGED`, `AUTOFILL_FILL`, `WEBAUTHN_OWN_APP_BYPASS_MSG = "PASSWD_SSO_OWN_APP_BYPASS"`. TS call sites import (adoption list includes the senders too: `extension/src/popup/App.tsx:36` for `PSSO_VAULT_STATE_CHANGED`, `background/index.ts`, the three form-detector `-lib.ts` files, `login-detector-lib.ts`, `autofill-lib.ts`, `webauthn-bridge.ts`); plain-JS twins (`autofill.js`, `webauthn-interceptor.js`) keep local literals with the existing "keep in sync" comment pattern (`constants.ts:84-86,102-103` precedent). Both members of each `.js`/`-lib.ts` pair updated.
- **Automated guard (new/extended test)**: extension test that value-pins each new constant (exact string literal) AND, for constants with a plain-JS twin, asserts the twin file's source contains the same literal (read the `.js` file content in the test — same drift-guard class as `extension-constants-sync.test.ts`, whose `extractStringConst` pattern can be reused). The existing sync test itself is app↔extension scoped and stays unchanged; this guard is TS↔plain-JS scoped within the extension.
- Acceptance: extension test suite passes locally (incl. the new twin-sync/value-pin test); raw literals gone from TS files (grep); twin-sync comments present.

### C14 — Exhaustive time-literal normalization (added Phase 3, user-requested)

Phase 3 review surfaced that the Phase 1 inventory (frequency-ranked sweep) missed many file-local time literals of the SAME class C2 normalized. User confirmed: normalize ALL literals that carry a time unit.

- **In scope** (→ `MS_PER_SECOND/MINUTE/HOUR/DAY` from `@/lib/constants/time`; values byte-identical):
  - file-local `const *_MS = <bare _000>` / `*_TTL_MS` / `*_TIMEOUT_MS` / `*_INTERVAL_MS` (e.g. `CACHE_TTL_MS = 30_000` → `30 * MS_PER_SECOND`). Directly resolves the "unit-comment magic number" anti-pattern.
  - inline `setInterval/setTimeout(_, N_000)`, `AbortSignal.timeout(N_000)`, `duration: N_000` → `N * MS_PER_*` (new named const if the value recurs in the file, else inline).
  - sec↔ms conversions `X * 1000` (sec→ms), `X / 1000` (ms→sec) including `Math.floor(Date.now() / 1000)` (Unix-epoch seconds) and `Math.ceil(retryAfterMs / 1000)` (HTTP Retry-After) → `* MS_PER_SECOND` / `/ MS_PER_SECOND`.
  - array delay literals `[1_000, 5_000, 25_000]` → `[1 * MS_PER_SECOND, 5 * MS_PER_SECOND, 25 * MS_PER_SECOND]`.
  - file-local time defaults `?? 300_000` / `envInt("X", 1000)` where the value is a duration → `5 * MS_PER_MINUTE` / `MS_PER_SECOND`.
- **Out of scope** (NOT a time unit — leave as-is): count/length/page caps (`z.string().max(1000)`, `MAX_CACHE_ENTRIES`, `*_MAX_SIZE`, `MAX_ROWS`, `*_BATCH_SIZE`), `prisma.ts` pool settings (C1 named-exclusion), env-schema bounds already handled in C5, bit lengths/ports.
- **Design decision (user-approved)**: use `MS_PER_*` constants directly (`x * MS_PER_SECOND`, `x / MS_PER_SECOND`). Do NOT introduce `secToMs`/`msToSec` helper functions — rounding policy varies per site (`Math.floor` for Unix epoch, `Math.ceil` for Retry-After, `Math.round` for display) so a single converter would mask the difference or proliferate into `msToSecFloor`/`msToSecCeil`; KISS/YAGNI; keeps the repo's established `MS_PER_*` convention. Existing `Math.floor/ceil/round` wrappers stay outside the division.
- Invariant (app-enforced): every replaced literal numerically identical; `time.ts` is import-free so client components stay bundle-safe.
- Forbidden pattern (acceptance): no `const \w*_MS = \d` bare-literal time constants remain in src/ non-test; no `[*/] 1000\b` for a time quantity remains in src/ non-test (excluding count/length contexts).
- Acceptance: `npx vitest run` + `npx next build` pass; targeted greps for the above return only out-of-scope (count/length) remainders.

### C13 — NOTIFICATION_BELL_LIMIT client/server placement fix

- Pre-existing violation surfaced by C3 review: `src/components/notifications/notification-bell.tsx:19` (`"use client"`) imports `NOTIFICATION_BELL_LIMIT` from `@/lib/validations/common.server` — a file whose header forbids client imports (it bundles safely today only because it happens to have zero server-only deps; the invariant is comment-enforced, not build-enforced).
- Fix: move `NOTIFICATION_BELL_LIMIT = 10` from `common.server.ts:109` to `common.ts` (client-shared constants home); update the import in `notification-bell.tsx`; no other consumers exist (grep-verified 2026-06-13). Value unchanged.
- Out of scope here: adding `import "server-only"` to `common.server.ts` — the `server-only` package is not currently a dependency; adding a build-enforced guard is tracked as `TODO(hardcoded-values-to-constants): add server-only guard to common.server.ts after dependency review` (see SC6).
- Acceptance: `grep -rn 'common.server' src/components/` → 0; vitest + build pass.

### C12 — CLI constants

- `cli/src/lib/crypto.ts`: `GCM_TAG_LENGTH = 16` module constant; slice sites at lines 201-202 use it.
- Agent timeouts: `AGENT_CHILD_TIMEOUT_MS = 10_000` shared by `commands/agent-decrypt.ts:356`, `commands/agent.ts:258`, `commands/decrypt.ts:122` — home: `cli/src/lib/time.ts` (alongside `MS_PER_MINUTE`); `VAULT_LOCK_POLL_INTERVAL_MS = 5_000` for `commands/agent.ts:197`.
- `cli/src/lib/oauth.ts`: `expiresIn` fallback `3600` → named `OAUTH_DEFAULT_EXPIRES_IN_SEC = 3600`; add `MCP_REGISTER_ENDPOINT`, `MCP_REVOKE_ENDPOINT`, `MCP_AUTHORIZE_ENDPOINT` beside existing `MCP_TOKEN_ENDPOINT` and use them (lines 194, 317, 409).
- API path constant: `/api/passwords` used 3× (`list.ts:39`, `export.ts:65`, `agent.ts:98`) → `API_PATH_PASSWORDS` in a new `cli/src/lib/api-paths.ts` (mirrors extension's module); single-use paths stay inline (documented as out of threshold).
- Acceptance: cli test suite passes; listed literals replaced (grep).

## Go/No-Go Gate

| ID  | Subject                                              | Status |
|-----|------------------------------------------------------|--------|
| C1  | Pure crypto-params module + adoption (src/)          | locked |
| C2  | Time arithmetic normalization (src/)                 | locked |
| C3  | RATE_WINDOW_MS adoption (40 files)                   | locked |
| C4  | TTL/timeout constant dedup (src/)                    | locked |
| C5  | env-schema bounds from time constants                | locked |
| C6  | Token prefix bypass fixes (mcpc_/scim_)              | locked |
| C7  | Web storage key constants                            | locked |
| C8  | Enumerated literal const-objects                     | locked |
| C9  | API_ERROR code adoption                              | locked |
| C10 | i18n numeric-limit interpolation (R27)               | locked |
| C11 | Extension constants                                  | locked |
| C12 | CLI constants                                        | locked |
| C13 | NOTIFICATION_BELL_LIMIT placement fix                | locked |

## Testing strategy

- `npx vitest run` — full suite (golden-vector crypto parity tests are the primary behavior guard for C1; i18n consistency tests guard C10; extension-constants-sync test guards mirrored values).
- `npx next build` — catches SSR/client bundle boundary violations (critical for C1 crypto-params and C9 client-side API_ERROR imports).
- Extension and CLI test suites run locally (VE2: not in pre-pr.sh).
- `npm run check:env-docs` after C5.
- `scripts/pre-pr.sh` before push.
- New tests added where review found silent-drift gaps (Round 1 findings T1/T2/T3):
  1. Crypto value-pins in `e2e/helpers/crypto.test.ts`: `AUTH_TAG_LENGTH === 16`, `AES_KEY_LENGTH === 256` imported directly from crypto-params (PBKDF2_ITERATIONS/IV_LENGTH already pinned via CRYPTO_CONSTANTS — preserved by keeping the object shape).
  2. `src/__tests__/i18n/tenant-admin-ttl-interpolation.test.ts`: formats the 8 changed TenantAdmin keys for both locales with the real constants; asserts no `{`/`}` residue and constant values present.
  3. Extension twin-sync/value-pin test for the new C11 message-type constants (TS constant ↔ plain-JS twin literal).
  All other surfaces remain guarded by existing suites — no further new tests.

## Considerations & constraints

- **Crypto files are the highest-risk surface.** Mitigation: value-identity (no constant value changes), golden-vector tests, no AAD/HKDF-info strings are touched (those are versioned protocol strings and stay file-local where they are today).
- **Import boundaries**: `common.server.ts` only into server code (C3 verified); `crypto-params.ts` import-free; `timing.ts` stays client-safe.
- **Plain-JS twins** in extension keep local literals by design (cannot import TS modules); the sync-comment convention is the guard.

### Scope contract

- **SC1 — iOS app (`ios/`)**: out of scope. Separate Swift toolchain; its crypto constants are guarded by AAD golden-vector parity tests; no TS-level reuse is possible. Owner: future iOS-side sweep if ever needed (`TODO(hardcoded-values-to-constants): iOS constant sweep not planned — parity tests are the guard`).
- **SC2 — Typed-error redesign for throw-message matching (E1/E2 pattern)**: out of scope. C9 replaces literals with constants only; converting `throw new Error(CODE)` string-matching to typed error classes is a behavior-adjacent redesign tracked as `TODO(hardcoded-values-to-constants): typed errors for cross-boundary error signaling`.
- **SC3 — Cross-codebase constant unification (src ↔ extension ↔ cli ↔ ios)**: out of scope/impossible — separate build boundaries. Mirrors stay; sync tests exist for extension-mirrored values. A parity test for HKDF info strings across the 3 TS codebases is a worthwhile follow-up: `TODO(hardcoded-values-to-constants): HKDF info-string parity test across src/extension/cli`.
- **SC4 — ADVISORY-class findings**: WebCrypto algorithm identifier strings (`"AES-GCM"`, `"SHA-256"` — spec-mandated idiom), `openapi-spec.ts` cookie-name doc string, HSTS/preflight header protocol values, per-route `rl:` key prefixes, per-route rate-limit `max` thresholds (deliberately route-specific tuning values, not duplicates — constantizing them would be a one-alias-per-route rename with no dedup benefit), `cli/src/lib/totp.ts` ↔ `extension/src/lib/totp.ts` duplication (intentional mirror), `VERIFIER_PBKDF2_ITERATIONS` in `src/lib/crypto/crypto-client.ts:22` and `cli/src/lib/crypto.ts:17` (semantically distinct from `PBKDF2_ITERATIONS` — verifier knob, kept separate by design; named exclusion in C1), single-use named file-local constants. Deliberately unchanged — each is either idiomatic, protocol-mandated, semantically distinct, or below the 2-occurrence threshold.
- **SC6 — Build-enforced server-only guard for `common.server.ts`**: out of scope. Requires adding the `server-only` package (new dependency) and verifying every importer; the live violation is fixed in C13, the structural guard is deferred: `TODO(hardcoded-values-to-constants): add server-only guard to common.server.ts after dependency review`. Worst case without it: a future server-only value added to common.server.ts silently bundles into the client; likelihood low (file header documents the rule, C13 removes the only violating import); cost to fix later: one dependency + one import line + re-verify importers.
- **SC5 — Whole-repo directory structure** (where constants modules should ultimately live): a separate planned review session exists for repo structure; this PR follows the current `src/lib/constants/` layout as-is.

## User operation scenarios

- A user unlocks the vault, decrypts entries, exports the vault, uses emergency access, rotates keys — all crypto paths must produce/accept byte-identical ciphertext (golden vectors + manual smoke: unlock → view entry → export → re-import).
- Tenant admin opens TenantAdmin settings — JIT/delegation TTL help text renders the same numbers as before (now interpolated).
- Extension user autofills credentials and saves a new login — message-type constants must keep exact values or the content-script ↔ background protocol breaks (twin files verified pairwise).
- Rate-limited API client hits a 429 on the same thresholds as before.

## Implementation Checklist

Impact analysis was performed during Phase 1 (3 parallel codebase sweeps + fingerprint + 3-round expert verification); per-contract file:line inventories live in the Contracts section above and are the authoritative work list.

### Batching (conflict-free waves)
- Wave 1 (parallel, disjoint trees): Batch E = C10 (messages/ + policy cards + privacy page + new i18n test); Batch F = C11 (extension/); Batch G = C12 (cli/).
- Wave 2 (parallel, disjoint trees): Batch A = C1 (src/lib/crypto + vault/setup route + e2e/helpers/crypto.test.ts value pins); Batch D = C6+C7+C8+C9+C13 (string constants across src routes/components/lib + test alignment).
- Wave 3 (single agent; overlaps Wave-2 files sequentially, no parallel conflict): Batch B/C = C2+C3+C4+C5 (time arithmetic + RATE_WINDOW_MS sweep + TTL dedup + env-schema). rate-limiters.ts gets BOTH its edits here (15*MS_PER_MINUTE and v1ApiKeyLimiter→RATE_WINDOW_MS).

### CI gate parity (Step 2-1 diff, 2026-06-13)
- pre-pr.sh covers: lint, vitest, build, check:env-docs, check:crypto-domains, check:bypass-rls, check:team-auth-rls, check:migration-drift, api-error-codes check, e2e-selectors check, gitleaks, refactor-phase-verify.
- CI-only gaps and dispositions:
  - Extension CI job (extension vitest) → run `cd extension && npm test` locally before completion (plan VE2).
  - CLI tests → run `cd cli && npm test` locally (same).
  - `licenses:check:*:strict` → no-op for this PR (zero dependency changes); CI re-verifies.
  - DB+Redis integration job → not required by any contract (VE1: pure refactor, unit+build verifiable); CI re-verifies.
- check:crypto-domains specifics: new `src/lib/crypto/crypto-params.ts` matches the `crypto-*.ts` glob and joins scanSet automatically. It contains no HKDF/AAD tokens; if the ledger check flags it, add to `LEDGER_EXEMPT` in `scripts/checks/check-crypto-domains.mjs` with justification "pure numeric cipher parameters (IV/tag/key lengths, PBKDF2 count); no HKDF info strings, no AAD scopes" and mirror the note in `docs/security/crypto-domain-ledger.md` per that file's convention.
- check:api-error-codes / api-error-body-drift: C9 touches API_ERROR usage — these gates re-verify automatically in pre-pr.
