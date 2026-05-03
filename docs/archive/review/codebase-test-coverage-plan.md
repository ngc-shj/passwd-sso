# Plan: Codebase-wide Test Coverage Closing

Date: 2026-05-03 (revised after Round 1 review)
Plan name: `codebase-test-coverage`
Branch: `test/codebase-test-coverage`
Status: Phase 1 (plan creation), Round 2 input

---

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + Auth.js v5 — security-critical password manager)
- **Test infrastructure**: unit + integration + E2E + CI/CD
  - Unit: Vitest (`vitest.config.ts`, `npm run test` / `npx vitest run`)
  - Integration: real-DB via `npm run test:integration` (excluded from default vitest run)
  - E2E: Playwright in `e2e/` directory
  - Coverage: v8 provider, threshold 60% (line) globally, 80% on `auth-or-token.ts` / `crypto-server.ts` / `crypto-team.ts`
- **Existing test count**: 646 test files for 916 source files
- **Critical files already at high coverage**: crypto, auth-or-token, scim, audit (per `coverage.include` allowlist + thresholds in `vitest.config.ts`)
- **Trigger**: user request — codebase has many `*.ts*` files without `*.test.ts*`; the recent `proxy.ts` decomposition into `src/lib/proxy/{api-route,auth-gate,cors-gate,csrf-gate,page-route,route-policy,security-headers}.ts` left those individual modules without dedicated unit tests

---

## Objective

Materially raise unit-test coverage across the codebase by adding dedicated tests for the modules currently lacking them, with priority to security-critical and high-fan-in code paths. Cover the entire codebase including the encryption-boundary `*-context.tsx` providers and hooks; only purely-presentational UI components are deferred to a follow-up branch.

Non-goals:
- Replacing existing integration / E2E coverage with mocked unit tests
- Refactoring source code beyond minor testability improvements (e.g., exporting an internal `_resetForTest` helper with `@internal` JSDoc)
- Increasing coverage thresholds in `vitest.config.ts` (a follow-up task once new tests have stabilized)

---

## Requirements

### Functional

1. Every newly added test file must execute under `npx vitest run` and pass
2. `npx next build` must continue to succeed after each batch (catches SSR bundling regressions)
3. New tests follow existing file conventions:
   - **Sibling test placement** for `src/lib/**` and `src/hooks/**` (e.g., `foo.ts` → `foo.test.ts` next to it)
   - **Centralized test placement** for orchestrator-level / cross-cutting tests (under `src/__tests__/`)
4. Reuse existing helpers under `src/__tests__/helpers/` (`mock-prisma`, `mock-auth`, `request-builder`, `mock-team-auth`, `mock-translator`, `session-cache-assertions`, `fixtures`) — do not invent parallel mock infrastructure
5. Tests verify behavior, not implementation details (one behavior per test, AAA structure)
6. Each test removes assertion → must fail (no decorative tests) — enforced via per-batch v8 *branch* coverage gate (see §Testing strategy)

### Non-functional

1. **Pre-declared 2-PR split** (per `feedback_pr_cadence_aggregate.md`, but each PR is one "phase"):
   - **PR1** = Batch P0 + Tier 1 (40 lib files) + Tier 1.5 (5 contexts) = 45 test files + 1 infra commit. Branch: `test/codebase-test-coverage` from main.
   - **PR2** = Tier 2 (32 files). Branch: `test/codebase-test-coverage-pt2` stacked on PR1's merge commit OR rebased onto main after PR1 merges. Reuses P0 infra.
   - Rationale: jsdom + Web Crypto verification (P0) is risky-novel infra; isolating Tier 1 + Tier 1.5 in PR1 lets PR2 ride proven infra.
2. Tests must isolate from one another (vitest `isolate: true` already enforced AT FILE level; new tests must not introduce cross-`it()` shared state — see Batch P0 infra change).
3. Mocks placed at system boundaries only. **Allowlist of mockable modules** (anything else requires per-case justification):
   - `@/lib/prisma`, `next-intl/middleware`, `next-intl/server`, `next-auth`, `next/headers`, `next/server` (NextResponse), `@/lib/http/with-request-log` (already in setup.ts), `@/lib/auth/session/session-cache`, `@/lib/auth/session/csrf` (when testing csrf-gate's delegation), `node:fs`, `node:fs/promises`, `@octokit/*`, `@aws-sdk/client-s3`.
   - `@/lib/audit/anchor-destinations/*` — allowed when testing `audit-anchor-publisher.ts` (the publisher's natural system boundary is the destination interface).
   - **`node:crypto`** — only `vi.spyOn(cryptoModule, 'randomBytes')` for randomness fixturing. **`vi.mock('node:crypto', ...)` is FORBIDDEN** (it would silently disable AES/HKDF). Grep gate enforces.
   - **`@simplewebauthn/server`** — mockable ONLY when testing consumers of its return values. Tests for the WebAuthn handlers themselves (`/api/webauthn/*`) MUST exercise real `verifyRegistrationResponse` / `verifyAuthenticationResponse` via fixture inputs.
4. No skipped tests (`it.skip` / `describe.skip`). If a test cannot be written, document why in the plan deviation log.
5. Tests are deterministic — no `setTimeout`-based waits, no real network, no random-seed-without-fixed-seed crypto. Use `vi.useFakeTimers()` for timer-based code.

### Security obligations

1. **Token validators MUST cover forged + expired + replayed token cases**. For *rotating* token validators (MCP refresh, JIT, DPoP-jti, share-link consumption, emergency-access acceptance), include "rejects already-consumed/replayed token" AND "replay revokes the entire rotation family" cases. Apply to Batch P2.
2. New tests **must not** weaken security primitives:
   - Do not mock `crypto-server.ts` HKDF, AAD construction, `crypto-client.ts`, `crypto-team.ts`, `envelope.ts` — let them run with real Web Crypto in the Node/jsdom env
   - For `envelope.ts` tests, include AAD-substitution rejection: ciphertext encrypted with AAD `A` MUST FAIL to decrypt under AAD `B`, AAD prefix `A||B`, AAD truncated, AAD bit-flipped — `decryptWithKey` MUST throw
   - Decryption-failure tests MUST assert thrown `Error.message` does NOT contain IV / auth-tag / ciphertext / key bytes (use unique sentinel byte sequence in test inputs and grep the message)
3. Test files must not embed real secrets. Use the existing setup-injected dummy keys (`SHARE_MASTER_KEY = "a".repeat(64)` etc. in `src/__tests__/setup.ts`).
4. Test-only exports MUST: (a) use `_resetXForTests` / `_test_*` naming convention; (b) carry JSDoc `@internal`; (c) NOT export key material / JWT signing secrets / cookie HMAC keys at any visibility — test via plaintext + observable side-effects only.
5. Tests for routes that cross tenant boundaries MUST include a cross-tenant access denial assertion (actor `tenantId` ≠ resource `tenantId` → assert deny). Owned by Batch P2 (team-auth, tenant-auth, delegation tests).
6. Validation tests (Batch P3) MUST assert **rejection at max+1 length** and **rejection at numeric upper-bound +1**, not just "boundary acceptance". Use `result.error.issues.find(i => i.path[0] === 'fieldName')` — do NOT couple to `z.treeifyError()` tree shape (Zod implementation detail).
7. Tests that mutate `process.env` MUST use `vi.stubEnv('NAME', 'value')`. Direct `process.env.X = ...` is prohibited. The global `afterEach(() => vi.unstubAllEnvs())` is added in Batch P0 (see §Implementation steps).
8. Proxy-gate tests must verify the **deny path is dominant**. For each gate, the deny cases MUST outnumber or equal the allow cases — see Batch P1 spec for explicit truth tables.

---

## Scope inventory (corrected)

After excluding test infrastructure (`src/__tests__/**`), pure type files (`src/types/**`, `*-types.ts`, `form-scope-config.ts`), pure constants (`src/lib/constants/**`), and Next.js boilerplate (`route.ts`, `page.tsx`, `layout.tsx`, `index.ts` barrels, stories): **248 net testable files**.

Inventory snapshot: `docs/archive/review/test-gen-2026-05-03/`:
- `untested-net.txt` (248)
- `untested-lib.txt` (64)
- `untested-hooks.txt` (7)
- `untested-components.txt` (170)
- `untested-app.txt` (2)
- `untested-other.txt` (5)
- Tier classifiers: `tier1-lib.txt`, `tier2-lib.txt`, `encryption-boundary-contexts.txt`

### Tier 1 — Critical (this branch)

| Group | Count | Files (source list) |
|---|---|---|
| Proxy decomposition | 7 | `src/lib/proxy/{api-route,auth-gate,cors-gate,csrf-gate,page-route,route-policy,security-headers}.ts` |
| Lib auth | 7 | `tier1-lib.txt` filter `^src/lib/auth/` |
| Validations | 9 | `src/lib/validations/*.ts` |
| Audit subsystem | 10 | `src/lib/audit/**` |
| Security helpers | 4 | `src/lib/security/*.ts` |
| Crypto | 2 | `src/lib/crypto/*.ts` |
| Key-provider | 1 | `src/lib/key-provider/*.ts` |
| **Tier 1 lib total** | **40** | (`tier1-lib.txt` — exact list) |

### Tier 1.5 — Encryption-boundary contexts (this branch, jsdom+RTL)

5 `*-context.tsx` files own the client-side encryption boundary (key derivation, vault unlock state, auto-lock timer). Promoted from Tier 3 because they are crypto-orchestration logic, not presentational UI:

```
src/lib/emergency-access/emergency-access-context.tsx
src/lib/team/team-vault-context.tsx
src/lib/vault/active-vault-context.tsx
src/lib/vault/auto-lock-context.tsx
src/lib/vault/vault-context.tsx
```

Source list: `encryption-boundary-contexts.txt`. Tested with jsdom + `@testing-library/react` (added in Batch P0).

### Tier 2 — Important (this branch)

| Group | Count | Source list |
|---|---|---|
| Tier 2 lib utilities | 19 | `tier2-lib.txt` (`src/lib/{directory-sync,ui,scim,email,blob-store,url,tenant,services,prisma,health,events,env-schema,utils}.ts` and similar) |
| Hooks (jsdom+RTL) | 6 | `untested-hooks.txt` minus `password-form-router.ts` (pure types) |
| i18n | 4 | `src/i18n/{locales,navigation,request,routing}.ts` |
| Workers | 1 | `src/workers/audit-anchor-publisher.ts` |
| App handlers | 1 | `src/app/[locale]/mcp/authorize/consent-form.tsx` (manifest.ts skipped — Next.js boilerplate) |
| **Tier 2 total** | **31** | |

### Effective net testable: **76 files** (PR1: 45, PR2: 31)

Counts updated after Round 2 audit (`password-form-router.ts` is pure types, dropped).

### Tier 3 — Components, follow-up branch (out of scope this branch)

170 component files under `src/components/**`. Reasons to defer (revised):
- Deferred for batching (not for E2E coverage — that claim was unverified). Splitting Tier 3 into its own PR keeps Tier 1+2 PR reviewable.
- E2E does cover user-visible flows but does NOT prove every component's edge-case behavior; a follow-up branch will systematically cover them.
- Follow-up branch: `test/components-test-coverage` (proposed; not created in this branch)

### Skipped — pure-data / framework-bound

| Files | Rationale |
|---|---|
| `src/lib/constants/**` (~25 files) | Pure const/enum exports |
| `src/types/**` (2 files) | Type-only |
| `*-types.ts`, `form-scope-config.ts`, `personal-login-fields-types.ts`, `team-login-fields-types.ts`, `entry-form-types.ts`, `translation-types.ts`, similar | Pure types |
| `src/__tests__/helpers/**`, `src/__tests__/setup.ts`, `src/__tests__/db-integration/{helpers,setup}.ts` | Test infrastructure, not test targets |
| `src/components/__tests__/*.ts` | Test infra |
| `src/app/manifest.ts` | Next.js framework convention; covered by `next build` |

---

## Technical approach

### Test framework (already in place)

- **Vitest** with `globals: true`, `environment: "node"` (default; per-file pragma overrides for hooks/contexts)
- **Setup file**: `src/__tests__/setup.ts` injects required env vars + initializes key-provider singleton
- **Aliases**: `@/` → `src/`
- **Coverage**: v8, allowlisted via `coverage.include` in `vitest.config.ts`

### Test patterns to apply

| Source category | Test pattern |
|---|---|
| Pure functions (validators, formatters) | Direct call, table-driven cases, no mocks |
| Async helpers calling Prisma | `vi.mock("@/lib/prisma")` via existing `mock-prisma`; table-driven incl. error paths |
| Auth helpers | `mock-auth`; allow/deny paths; assert audit emission shape |
| Proxy gates | Construct `NextRequest` via `request-builder`; assert response shape; **deny-path-dominant** truth tables |
| route-policy.ts | **Type-driven exhaustiveness**: `Record<RoutePolicyKind, TestCase[]>` so missing kind = TS error at compile. Verify: deleting one entry causes `npx tsc --noEmit` to fail. |
| Encryption-boundary contexts (.tsx) | jsdom env (`// @vitest-environment jsdom` per file pragma); `@testing-library/react` `renderHook` for the context Provider's hook surface; assert state transitions of `encryptionKey` in unlock/lock/auto-lock paths |
| Hooks (.ts/.tsx) | jsdom env per-file pragma; `@testing-library/react` `renderHook`; mock fetch via the allowlist boundary |
| `*-context.tsx` mocks | Mock only `fetch` + storage (sessionStorage/localStorage); do NOT mock crypto primitives — they must run with real Web Crypto |

### Reuse over invention

Before writing a new mock or fixture, check:
- `src/__tests__/helpers/{fixtures,mock-prisma,mock-auth,mock-team-auth,mock-translator,request-builder,session-cache-assertions}.ts`
- `src/__tests__/setup.ts` (process.env defaults — DO NOT mutate directly)

If a needed helper does not exist, extend the existing helper rather than duplicating.

### Sub-agent strategy

For mechanical generation, dispatch a Sonnet sub-agent per **batch** (5–10 related files), each batch sharing one set of mocks. Each batch:
- Generates tests
- Runs `npx vitest run -- <new-test-glob>` to verify
- Runs full suite at batch end (`npx vitest run`)
- Runs `npx next build` at end of every other batch
- Captures coverage delta (see §Testing strategy)
- Commits with message `test(<area>): add <category> coverage (Batch P<n>)`

### Per-batch coverage delta gate (developer-discipline tool, NOT CI-enforced)

The v8 coverage reporter writes to `coverage/coverage-final.json` (istanbul-shape, per-file `s:`/`b:`/`f:` counters). The diff is per-batch (compare post-P<n-1> to post-P<n>), not against the original baseline.

```bash
# After P0 infra commit: snapshot to .coverage-snapshots/post-P0/
npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=.coverage-snapshots/post-P0
mv .coverage-snapshots/post-P0/coverage-final.json .coverage-snapshots/post-P0.json

# After each subsequent batch P<n>:
npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=.coverage-snapshots/post-P<n>
mv .coverage-snapshots/post-P<n>/coverage-final.json .coverage-snapshots/post-P<n>.json
node scripts/coverage-diff.mjs .coverage-snapshots/post-P<n-1>.json .coverage-snapshots/post-P<n>.json --files <batch P<n> targeted file globs>
```

`scripts/coverage-diff.mjs` (new, ~50-80 LOC, included in P0):
- Reads two istanbul-shape JSON files
- Filters to `--files` (passed explicitly per batch — the new-test target list)
- Asserts every targeted file's covered-line count strictly increases AND covered-branch count strictly increases
- Exits 1 with a per-file diff on regression
- Uses bracket-access only (no `Object.assign(target, parsed)` — defense against prototype pollution from parsed JSON)

The `.coverage-snapshots/` directory is gitignored (developer-local tool); the snapshots are not committed. Reviewer trusts the commit log shows the gate ran for each batch (record output of `coverage-diff.mjs` in the commit body).

### Pre-PR check (before final commit, before PR)

```bash
scripts/pre-pr.sh   # per memory feedback_run_pre_pr_before_push.md
npx vitest run       # mandatory
npx next build       # mandatory
```

---

## Implementation steps

1. **Pre-flight**: switch to `main`, pull, create branch `test/codebase-test-coverage` (per memory `feedback_pull_before_branch.md`, `feedback_no_japanese_branch_names.md`).
2. **Commit plan + inventory snapshot**: `docs/archive/review/codebase-test-coverage-plan.md`, `codebase-test-coverage-review.md`, `test-gen-2026-05-03/*.txt`.
3. **Batch P0 — Test infrastructure (single small commit)**:
   - Add to `src/__tests__/setup.ts`:
     - `import { afterEach } from "vitest";` (if not already imported)
     - `afterEach(() => { vi.unstubAllEnvs(); });`
   - **Verify** `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` are already in `package.json` devDependencies (Round 2 audit confirmed these are installed). **No npm install needed** — the per-file `// @vitest-environment jsdom` pragma reads `jsdom` automatically when present.
   - **jsdom Web Crypto verification probe** — add a minimal probe test (`src/__tests__/jsdom-web-crypto-probe.test.ts`) that runs under `// @vitest-environment jsdom` and asserts `globalThis.crypto.subtle` exists, then performs a single `deriveBits` round-trip with HKDF + AES-GCM-256 + 12-byte IV. If the probe fails, fall back to `// @vitest-environment node` for crypto-bearing tests AND document this in the deviation log. The probe protects Tier 1.5 (P6) and P5 envelope tests from silent fallback to a partial polyfill.
   - Add `scripts/coverage-diff.mjs` (~50-80 LOC) per spec in §Per-batch coverage delta gate
   - Add `.coverage-snapshots/` to `.gitignore`
   - Capture initial coverage snapshot: `npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=.coverage-snapshots/post-P0` then `mv .coverage-snapshots/post-P0/coverage-final.json .coverage-snapshots/post-P0.json`
   - **Note (per memory `feedback_no_suppress_warnings.md`)**: setup.ts may legitimately need `process.env.X = ...` for one-time global baselines (env vars consumed at module import time before any `beforeEach` fires). The §Testing strategy 7 grep gate excludes `src/__tests__/setup.ts` from the prohibition; per-test files MUST use `vi.stubEnv`.
   - Run vitest — must still pass without behavior change
   - Commit
4. **Batch P1 — Proxy 7 modules**:
   - `src/lib/proxy/route-policy.test.ts` — **Type-driven exhaustiveness** via `Record<RoutePolicyKind, TestCase[]>`. Plus negative classification adversarial inputs for `PUBLIC_SHARE`: `/api/share-links/foo/bar/content`, `/api/share-links//content`, `/api/share-links/foo%2Fbar/content`, `/api/share-links/foo/content/extra`, `/api/share-links/foo/content?qs`, paths with `..`, NUL bytes, and `API_V1` requiring trailing slash.
   - `src/lib/proxy/auth-gate.test.ts` — mock `@/lib/auth/session/session-cache` (NOT Redis directly). Cases: `getSessionInfo` cache-hit (mocked `getCachedSession` returns SessionInfo, no fetch fired); cache-miss (mocked returns null, fetch fired, `setCachedSession` called); `hasSessionCookie` true/false; `extractSessionToken` extraction & malformed-cookie path. **Fail-closed**: fetch throws → `{ valid: false }`, no cache write; 500 → `{ valid: false }`; malformed JSON → `{ valid: false }`; `resolveUserTenantId` throws → `tenantId` undefined NOT propagated.
   - `src/lib/proxy/cors-gate.test.ts` — Bearer-bypass detection; OPTIONS preflight (allowed/blocked/missing Origin); reflective-origin guards. **Deny enumeration**: `chrome-extension://*` rejected for non-Bearer-bypass routes; `EXTENSION_TOKEN_ROUTES` exact-match (no prefix evasion); `/api/extension/token` accepts only exact path.
   - `src/lib/proxy/csrf-gate.test.ts` — **Truth table over `(cookiePresent? × method ∈ {GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE})`** — assert exactly the cookie+mutating cell triggers enforcement; assert all 9 other cells short-circuit. Plus `assertSessionCsrf` delegation: mock `@/lib/auth/session/csrf` returning null → returns null; returning 403 → pass-through. **Note**: Host-fallback and admin-reset stricter check are NOT in csrf-gate (they live in `csrf.ts` and route handler respectively — out of scope here).
   - `src/lib/proxy/security-headers.test.ts` — CSP / HSTS / X-Frame-Options applied; nonce propagation; Permissions-Policy header presence.
   - `src/lib/proxy/api-route.test.ts` — `handleApiAuth` dispatch: Bearer-bypass routes vs cookie-required vs preflight; assert it does NOT apply security headers. **Cookie+Bearer combo deny**: cookie+Bearer on Bearer-bypass route MUST take session-authenticated branch and run IP restriction — assert `getSessionInfo` is called, NOT skipped.
   - `src/lib/proxy/page-route.test.ts` — `handlePageRoute` orchestration: i18n middleware called, access-restriction called, passkey enforcement audit emitted exactly once per dedup window. **Module-state isolation + encapsulation refactor**: `page-route.ts` currently exports `passkeyAuditEmitted` Map directly (full mutable surface — security boundary leak per Round 2 S16). In P1: (a) make `passkeyAuditEmitted` and `PASSKEY_AUDIT_MAP_MAX` MODULE-PRIVATE (drop `export`); (b) add `_resetPasskeyAuditForTests()` and `_passkeyAuditSizeForTests()` test-only exports (with `_` prefix + `@internal` JSDoc); (c) update existing `src/__tests__/proxy.test.ts` callers (`_passkeyAuditEmitted.clear()` → `_resetPasskeyAuditForTests()`). Tests use only sanctioned helpers + the public `recordPasskeyAuditEmit()`. Covers `PASSKEY_AUDIT_MAP_MAX` overflow eviction.
   - **Final P1 step**: audit `src/__tests__/proxy.test.ts` (953 lines) — remove cases now duplicated at gate level. Orchestrator file should test orchestration (correct dispatch + ordering of gates) only, not gate internals.
   - Run vitest, run coverage-diff, commit
5. **Batch P2 — auth + vault libs (~8 files)**:
   - For each `src/lib/auth/*.ts` without a test, write sibling `*.test.ts`. Cover happy path + permission-denied + token-expired + token-forged paths. **For rotating-token validators** (MCP refresh, JIT, DPoP-jti, share-link consumption, emergency-access acceptance): include "rejects already-consumed/replayed token" AND "replay revokes the entire rotation family" cases.
   - **Cross-tenant denial obligation**: tests that touch team-auth / tenant-auth / delegation MUST include a cross-tenant scenario where actor `tenantId` ≠ resource `tenantId` → assert deny.
   - Mock Prisma via `mock-prisma`, auth via `mock-auth`.
   - Run vitest, run coverage-diff, commit.
6. **Batch P3 — Zod validations** (9 files):
   - For each schema, table-driven `parse(...)` tests: valid input, each required-field-missing case, **rejection at max+1 length**, **rejection at max-bound numeric +1**, type-mismatch, `z.strict()` rejection of unknown fields where declared.
   - **Do not** assert full `z.treeifyError()` tree shape. Use `result.error.issues.find(i => i.path[0] === 'fieldName')` and assert on `code` / `message` only when message is part of the contract.
   - Run vitest, run coverage-diff, commit.
7. **Batch P4 — Audit subsystem** (10 files):
   - `audit-chain.ts` (chain hash continuity, tampering detection); `audit-display.ts` (formatting per action type); `audit-log-stream.ts` (stream behavior, pagination cursor); `audit-user-lookup.ts` (fallback for deleted users); `audit.ts` (logAudit writes outbox row with correct schema); `anchor-manifest.ts` (manifest construction); `anchor-destinations/{filesystem,github-release,s3}-destination.ts` (write/upload mock; failure path); `destination.ts` interface — only test if it exports runtime helpers; otherwise skip with rationale logged.
   - **Coverage regression check**: P4 must run `npx vitest run --coverage` on `src/lib/audit/` before/after. Confirm per-file lines% does NOT regress for files already in `coverage.include` (`audit.ts`, `audit-outbox.ts`, `audit-query.ts`). If regression, augment with explicit lines previously covered by indirect path.
   - Mock `node:fs/promises`, `@octokit/*`, `@aws-sdk/client-s3` — system boundaries only.
   - Run vitest, run coverage-diff, commit.
8. **Batch P5 — Security helpers + Crypto + key-provider** (~7 files):
   - For each: verify uses real crypto where applicable; mock only the boundary.
   - **AAD substitution rejection** for envelope.ts: ciphertext encrypted with AAD A must FAIL to decrypt under AAD B / A||B / truncated / bit-flipped — `decryptWithKey` MUST throw.
   - **No-secrets-in-error-messages**: decryption-failure tests MUST assert thrown `Error.message` does NOT contain IV / auth-tag / ciphertext / key bytes (use unique sentinel byte sequence, grep the message).
   - Run vitest + `next build` (mid-checkpoint), run coverage-diff, commit.
9. **Batch P6 — Encryption-boundary contexts** (5 files):
   - First commit: per-file `// @vitest-environment jsdom` pragma usage in test files; setup local `mock-fetch.ts` helper if the existing `request-builder` is insufficient for the Provider tests.
   - Each context tested via `@testing-library/react` `renderHook` over its custom hook, asserting state transitions: `unlock` → `encryptionKey` set; `lock` → key zeroed/null; auto-lock timer fires correctly under `vi.useFakeTimers()`; PRF unlock path (when applicable).
   - Mock `fetch` for `/api/vault/*` and `sessionStorage` interactions; do NOT mock crypto-client / crypto-team / crypto-aad.
   - Run vitest, run coverage-diff, commit.
10. **Batch P7 — Hooks** (6 files, after dropping `password-form-router.ts` pure-types):
    - Per-file `// @vitest-environment jsdom`. `renderHook` from `@testing-library/react`. Mock fetch via the allowlist.
    - RTL setup is **mandatory for ALL hooks** — pure-helper extraction is NOT permitted as a substitute, even for non-security-bearing hooks. (Round 2 F16 clarification: removes the previous "or document deviation" escape clause.)
    - Run vitest, run coverage-diff, commit.
11. **Batch P8 — Tier 2 lib utilities** (19 files):
    - Sub-batched in groups of ~5. Each sub-commit includes 5 files + tests.
    - Sub-batch composition (from `tier2-lib.txt`):
      - P8a: directory-sync (3) + ui (2) = 5
      - P8b: scim (2) + email (2) + blob-store (2) = 6 (approximately split into 5)
      - P8c: utils.ts + url + tenant + services + prisma.ts = 5
      - P8d: health.ts + events.ts + env-schema.ts = 3
    - Run vitest each sub-batch, coverage-diff each sub-batch, commit each sub-batch.
12. **Batch P9 — i18n + workers + app handler** (6 files; split into 2 sub-commits to keep env consistent):
    - **P9a — node env (5 files)**: `i18n/{routing,navigation,request,locales}.ts` + `workers/audit-anchor-publisher.ts`. Run vitest, coverage-diff, commit.
    - **P9b — jsdom env (1 file)**: `consent-form.tsx` (reuses Tier 1.5 jsdom infra). Run vitest + `next build`, coverage-diff, commit.
    - manifest.ts skipped (Next.js framework boilerplate)
13. **Final pre-PR**:
    - Run `scripts/pre-pr.sh`
    - Run `npx vitest run` — full suite green
    - Run `npx next build` — green
    - Run `npx vitest run --coverage` — final coverage delta vs baseline (note: see §Risks for the components-in-coverage.include consequence)
    - **Per memory `feedback_pr_cadence_aggregate.md`**: branch reaches PR-ready state. STOP before opening PR (per user instruction).

---

## Testing strategy (the work IS testing — strategy here is for VERIFYING the new tests are good)

1. **Per-batch coverage delta gate** (replaces 3-file mutation sample): every batch must strictly increase `lines-covered` AND cover ≥ 1 new branch per targeted file (`scripts/coverage-diff.mjs` enforces).
2. **Mock allowlist enforcement**: after each batch, grep `vi.mock(` in new files. Each `vi.mock(...)` argument must match the allowlist in §Non-functional 3 OR include a comment line above naming the justification (e.g., `// boundary: mocking external NPM lib X`).
3. **Type-driven exhaustiveness for enums**: route-policy and any other enum/discriminated-union-driven test must use `Record<EnumType, TestCase[]>` so a missing key is a TypeScript error at test-compile.
4. **No `it.skip` / `describe.skip`** — grep enforces (`scripts/pre-pr.sh` should fail if any new `*.test.ts` contains either).
5. **No `// @ts-ignore` / `// @ts-nocheck`** in new test files — grep enforces.
6. **No `any` in new test files** — eslint `@typescript-eslint/no-explicit-any` already configured globally.
7. **No `process.env.X = ...`** in new tests — grep enforces; `vi.stubEnv` is the only allowed env mutation.

---

## Considerations & constraints

### Risks

1. **Coverage threshold delta will be small** — `vitest.config.ts:46` includes `src/components/**/*.{ts,tsx}` (170 untested components remain in denominator until Tier 3 follow-up). Decision: accept small headline % delta, report per-file deltas via `scripts/coverage-diff.mjs`. Do NOT temporarily exclude components from `coverage.exclude` (would mask future component test gaps).
2. **Audit lib already in `coverage.include` may regress per-file** when adding direct unit tests with mocked Prisma. Mitigated by P4 explicit before/after coverage check with regression-rejection.
   - **Rollback condition**: if a P4 audit-X.test.ts addition causes audit-X.ts coverage to drop below the 60%/80% threshold AND augmentation is not possible without re-doing integration testing, REVERT the dedicated audit-X.test.ts (covered indirectly by audit-logger.test.ts) and log skip with rationale in the deviation log.
3. **Hidden behavior coupling** — A "pure" lib function may rely on global state set by `setup.ts`. Mitigated by Batch P0 `vi.unstubAllEnvs()` in afterEach + the `vi.stubEnv` rule.
4. **Module-level state in page-route** — addressed by P1 encapsulation refactor (make Map private, expose only sanctioned helpers).
5. **Crypto setup ordering** — `setup.ts` initializes `KeyProvider`. Tests that re-init must `_resetKeyProvider()` then re-await `getKeyProvider()`. Use the existing pattern from `key-provider/index.test.ts`.
6. **jsdom Web Crypto completeness** — `jsdom 28.x` exposes `globalThis.crypto.subtle` via Node webcrypto, but historically had subtle gaps for HKDF + AES-GCM-256 + 12-byte IV. P0 probe test guards against silent fallback; if the probe fails, encryption-boundary contexts and crypto-bearing hooks fall back to `// @vitest-environment node` and the deviation is logged.
7. **PR-pair branch protocol** — PR1 = `test/codebase-test-coverage` (Tier 1 + Tier 1.5 + P0 infra). PR2 = `test/codebase-test-coverage-pt2` rebased onto main after PR1 merges (or stacked while PR1 is open). PR2 commit messages should reference PR1 by SHA (NOT bare `#NNN` per memory `feedback_pr_body_bare_hash_check.md`).

### Out of scope

- Tier 3 components (170 files) — separate follow-up branch `test/components-test-coverage`
- New integration tests (`*.integration.test.ts`) — separate concern, requires live DB
- E2E test additions — already adequate per `e2e/`
- Refactoring source code beyond minor testability tweaks (only `_resetXForTests` exports allowed, with `@internal` JSDoc)
- Raising coverage thresholds in `vitest.config.ts` — wait for new tests to stabilize

### Anti-deferral log (running)

| Item | Reason / Anti-Deferral check |
|---|---|
| `src/lib/constants/**` | Pure const exports — testing them tests TypeScript, not behavior. Skipped per `~/.claude/rules/common/testing.md` "tests must fail for a real reason" |
| `src/types/**` and `*-types.ts` files | Type-only files; no runtime to test |
| `src/__tests__/helpers/**` & `setup.ts` | Test infrastructure, not test targets |
| 170 component files | Out of scope (different feature). Tracked via TODO marker `TODO(test/components-test-coverage)`; follow-up branch `test/components-test-coverage` to be created after this branch ships |
| `src/app/manifest.ts` | Next.js framework convention; covered by `next build` |
| `src/app/[locale]/...` route layout / page files | Covered by E2E + `next build` |
| `src/lib/audit/anchor-destinations/destination.ts` (interface only) | If only types/interface exports, skip with rationale logged in P4 deviation |

Update this log inline whenever a finding is skipped during Phase 2.

---

## User operation scenarios

This plan does not change runtime behavior — only adds tests. Scenarios are about the development workflow:

1. **Developer adds a new proxy gate** — finds a sibling `*.test.ts` template; orchestrator-level `proxy.test.ts` shrinks to dispatch tests only.
2. **Refactor of `route-policy.ts`** — type-driven exhaustive table fails at TypeScript compile when a route is added/removed without a test case.
3. **CI run on PR touching `csrf-gate.ts`** — gate unit test fails fast (~ms) on deny-path regression, faster than the orchestrator integration test (~seconds).
4. **Coverage report** — Per-file deltas reported via `scripts/coverage-diff.mjs`. Headline % delta will be modest because Tier 3 components remain in denominator; per-file deltas are the real signal.
5. **Security audit** — New tests document expected auth/authz behavior (forged + expired + replayed token cases, cross-tenant denial, fail-closed paths) of each gate, providing executable specification for the reviewer.
6. **Future Tier 3 follow-up branch** — `test/components-test-coverage` reuses jsdom + RTL infra added in this branch's Batch P0; faster ramp-up.
