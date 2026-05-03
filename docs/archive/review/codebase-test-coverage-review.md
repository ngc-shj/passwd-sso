# Plan Review: codebase-test-coverage
Date: 2026-05-03
Review round: 1

## Changes from Previous Round
Initial review.

---

## Functionality Findings

### F1 — Major: `csrf-gate` test bullet describes behaviors not in csrf-gate
- **File**: plan §Step 3 P1, line referencing csrf-gate.test.ts
- **Evidence**: `src/lib/proxy/csrf-gate.ts:24-56` — module is two helpers; `assertSessionCsrf` delegates to `assertOrigin` from `@/lib/auth/session/csrf`. Host-header fallback lives in `assertOrigin`, not csrf-gate. Admin-reset stricter check lives in `src/app/api/vault/admin-reset/route.ts`.
- **Problem**: Plan claims P1 csrf-gate test covers "Host fallback when APP_URL unset" and "admin-reset stricter route-level guard", neither of which is in csrf-gate.
- **Impact**: Sub-agent following P1 produces confused tests — duplicates `assertOrigin` cases (already covered elsewhere) or fails to find admin-reset path in csrf-gate at all.
- **Fix**: Replace P1 csrf-gate.test.ts bullets: (1) `shouldEnforceCsrf` truth table over `{cookiePresent, method}`. (2) `assertSessionCsrf` delegation: returns null when assertOrigin returns null; pass-through when assertOrigin returns 403 (`vi.mock("@/lib/auth/session/csrf")`). Note Host-fallback / admin-reset belong to `csrf.test.ts` and admin-reset route test.

### F2 — Major: "295 net testable" count inflated by 12 out-of-scope files
- **Evidence**: `untested-net.txt` includes 10 `src/__tests__/*` entries (helpers + setup + db-integration) and 2 `src/types/*` entries. Plan §Skipped explicitly excludes `src/__tests__/helpers/**`, `src/__tests__/setup.ts`, `src/types/**`.
- **Problem**: Inventory snapshot does not match the plan's Skipped section.
- **Impact**: Reviewer cannot trust counts. Real net testable ≈ 283.
- **Fix**: Regenerate inventory excluding `src/__tests__/**`, `src/types/**`, OR explicitly note "Net=295 includes 12 out-of-scope files; effective testable=283."

### F3 — Major: Plan references `untested-app.txt` which does not exist
- **Evidence**: Only `untested-{components,hooks,lib,net,other}.txt` exist.
- **Problem**: Batch P8 cannot locate the source list for "src/app/** route handlers (2 untested)".
- **Fix**: Either create `untested-app.txt` listing the 2 app handler files, or update plan to reference a `grep '^src/app/'` over `untested-net.txt`. Name the 2 handlers explicitly.

### F4 — Major: Tier 3 deferral does not account for components already in `coverage.include`
- **Evidence**: `vitest.config.ts:46` includes `src/components/**/*.{ts,tsx}` in coverage; threshold 60%.
- **Problem**: Tier 1+2 coverage delta will under-represent the work since 172 untested components remain in the denominator.
- **Fix**: Add to §Risks: "Components are in `coverage.include` but Tier 3 is deferred. Either (a) temporarily exclude `src/components/**` via `coverage.exclude` for Tier 1+2 baseline, or (b) accept small headline % delta and report per-file deltas. Decision must be explicit."

### F5 — Major: Audit Tier 1 files in `coverage.include` — direct unit tests may LOWER coverage if mocks replace previously-exercised real-code paths
- **Evidence**: `coverage.include` contains `audit.ts`, `audit-outbox.ts`, `audit-query.ts`. `audit.ts` lacks dedicated test — coverage comes indirect via `audit-logger.test.ts`.
- **Problem**: Mocking Prisma to add direct `audit.test.ts` may skip previously-real Prisma paths.
- **Fix**: P4 must run `npx vitest run --coverage` on `src/lib/audit/` before/after; confirm per-file lines% does not regress. If regression, keep integration-style coverage path or augment.

### F6 — Minor: Missing `mock-session-cache` helper guidance for proxy/auth-gate tests
- **Evidence**: `auth-gate.ts:14-18` imports `@/lib/auth/session/session-cache` (Redis-backed). No `mock-redis.ts` / `mock-session-cache.ts` in helpers.
- **Fix**: Add to P1: "auth-gate.test.ts mocks `@/lib/auth/session/session-cache` (NOT Redis directly) — `getCachedSession`/`setCachedSession` are the boundary."

### F7 — Minor: Plan's "in-process session cache" wording stale
- **Evidence**: `src/lib/proxy/auth-gate.ts:1-10` header comment: "Per-worker in-process Map removed in the sessioncache-redesign refactor."
- **Fix**: Update auth-gate test bullet to be explicit: "cache-hit path (mocked `getCachedSession` returns SessionInfo, no fetch fired); cache-miss path (mocked returns null, fetch fired, `setCachedSession` called)."

### F8 — Minor: Batch P8 file list hand-waved; P6 ~30 vs leftover ~49 mismatch
- **Evidence**: 94 lib − Tier 1 (~45) = 49 leftover, plan claims P6 ~30.
- **Fix**: Enumerate Tier 2 lib file list explicitly; reconcile counts.

### F9 — Minor: Anti-deferral inconsistent on `src/app/manifest.ts` vs Batch P8 handlers
- **Fix**: Name the 2 handlers explicitly (or move to skip list).

### F10 — [Adjacent] Major: Cross-tenant access denial obligation has no batch owner
- **Routing**: Security expert (overlaps S11)
- **Fix**: Either drop obligation 3, or add explicit task to Batch P2 (team-auth/tenant-auth/delegation tests must include cross-tenant scenario).

---

## Security Findings

### S1 — Major: Missing token-replay / rotation-family test obligations
- **Evidence**: Plan §Security obligations 1 covers forged + expired but NOT replay; CLAUDE.md describes refresh-token rotation grouped by `familyId` with replay detection that revokes the entire family.
- **Fix**: Add: "Tests for rotating-token validators (MCP refresh, JIT, DPoP-jti, share-link consumption, emergency-access acceptance) MUST include 'rejects already-consumed/replayed token' AND 'replay revokes the entire rotation family' cases."

### S2 — Major: csrf-gate test omits cookieless DENY path enumeration
- **Evidence**: `csrf-gate.ts:42-47` `shouldEnforceCsrf` is two-dimensional: `hasSessionCookie && MUTATING_METHODS.has(method)`. Plan describes positive case only.
- **Fix**: Truth table over (cookie present? × method ∈ {GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE}) — assert exactly the cookie+mutating cell triggers enforcement; assert all 9 other cells short-circuit.

### S3 — Major: route-policy test omits PUBLIC_SHARE regex adversarial inputs
- **Evidence**: `route-policy.ts:91-95` PUBLIC_SHARE regex `^/api/share-links/[^/]+/content$` bypasses CSRF + auth.
- **Fix**: route-policy test must include negative inputs that look like public-share but must NOT classify: `/api/share-links/foo/bar/content`, `/api/share-links//content`, `/api/share-links/foo%2Fbar/content`, `/api/share-links/foo/content/extra`, `/api/share-links/foo/content?qs`, paths containing `..`, NUL bytes. API_V1 must require trailing slash.

### S4 — Major: cors-gate test omits cookie+Bearer combo + chrome-extension origin restriction
- **Evidence**: `api-route.ts:60-72` Bearer-bypass only when `!cookiePresent` — IP restriction must still gate when both are sent.
- **Fix**: cors-gate test: (a) chrome-extension://* rejected for non-Bearer-bypass routes; (b) EXTENSION_TOKEN_ROUTES exact-match (no prefix evasion). api-route test: cookie+Bearer combo on Bearer-bypass route MUST take session-authenticated branch and run IP restriction — assert `getSessionInfo` called.

### S5 — Major: auth-gate test omits fail-closed verification on session-fetch error
- **Evidence**: `auth-gate.ts:111-113` returns `{ valid: false }` on thrown error. Plan does not require fail-closed test.
- **Fix**: Add fail-closed cases: fetch throws → `{ valid: false }`, no cache write; 500 → `{ valid: false }`; malformed JSON → `{ valid: false }`; `resolveUserTenantId` throws → `tenantId` undefined NOT propagated.

### S6 — Major: Test-only export naming convention not enforced
- **Evidence**: `nonce.ts:137` shows `_resetDpopNonceServiceForTests` convention; not enforced.
- **Fix**: Add to Security obligations: "Test-only exports MUST: (a) use `_resetXForTests` / `_test_*` naming; (b) JSDoc `@internal`; (c) NOT export key material/JWT signing secrets/Cookie HMAC keys at any visibility — test via plaintext + observable side-effects only."

### S7 — Major: vault-context.tsx and similar Tier 3'd but own encryption boundary
- **Evidence**: `src/lib/vault/vault-context.tsx:13-48` imports 14 crypto primitives; orchestrates key derivation.
- **Fix**: Promote `vault-context.tsx`, `active-vault-context.tsx`, `auto-lock-context.tsx`, `team-vault-context.tsx`, `emergency-access-context.tsx` OUT of Tier 3. Either test as Tier 1 (with jsdom+RTL infra) or extract pure logic into helpers.

### S8 — Minor: AAD-substitution rejection tests required for envelope.ts
- **Evidence**: `envelope.ts:1-9` doc: "Cross-subsystem ciphertext substitution is prevented by per-caller AAD shapes."
- **Fix**: P5 envelope test: ciphertext encrypted with AAD A must FAIL to decrypt under AAD B / A||B / truncated / bit-flipped — `decryptWithKey` MUST throw.

### S9 — Minor: Validation tests need rejection-at-max+1, not just boundary
- **Fix**: P3 reword: "valid input, required-field-missing, **rejection at max+1 length**, **rejection at max-bound numeric +1**, type-mismatch, `z.strict()` rejection of unknown fields where declared."

### S10 — Minor: process.env mutation isolation between tests
- **Evidence**: `setup.ts:19-34` mutates env directly; `vitest isolate: true` only isolates files, not `it()` blocks.
- **Fix**: Mandate `vi.stubEnv` + `vi.unstubAllEnvs` (added to global afterEach in setup.ts). Enforced for: KEY_PROVIDER, TRUST_PROXY_HEADERS, TRUSTED_PROXIES, APP_URL, AUTH_URL, CSP_MODE, all *_MASTER_KEY.

### S11 — Minor: Cross-tenant isolation tests obligation unowned (overlaps F10)
- **Fix**: see F10. Add to Batch P2: "team-auth/tenant-auth/delegation tests MUST include cross-tenant scenario where actor tenantId ≠ resource tenantId → assert deny."

### S12 — [Adjacent] Minor: Security-bearing hooks need RTL setup mandatory
- **Routing**: Testing expert (overlaps T1)
- **Fix**: P7: "if hook references crypto-client / auto-lock / vault-key state / session-revocation, RTL setup is mandatory."

### S13 — [Adjacent] Minor: No-secrets-in-error-messages not tested
- **Routing**: Testing expert
- **Fix**: P5: "decryption-failure tests MUST assert thrown `Error.message` does NOT contain IV/auth tag/ciphertext/key bytes (use unique sentinel byte sequence)."

---

## Testing Findings

### T1 — Major: Hook testability deferred; decide now
- **Evidence**: `vitest.config.ts:7` `environment: "node"`; hooks need jsdom + RTL; not in package.json.
- **Fix**: Either move all 10 hooks to Tier 3, OR commit to adding `@vitest-environment-jsdom` (or `happy-dom`) + `@testing-library/react` as Batch P0 infra commit. List exact deps. Use per-file `// @vitest-environment jsdom` pragma.

### T2 — Major: 3 hook inventory entries are pure-type files
- **Evidence**: `form-scope-config.ts`, `personal-login-fields-types.ts`, `team-login-fields-types.ts` — only types/interfaces.
- **Fix**: Move these 3 to Skipped — pure-data files. Audit also: `src/lib/vault/entry-form-types.ts`, `src/lib/blob-store/types.ts`, `src/lib/email/types.ts`, `src/lib/translation-types.ts`, `src/lib/key-provider/types.ts`. Update Tier 2 hook count from 10 to 7.

### T3 — Major: 5 *-context.tsx files in Tier 1/2 need same jsdom+RTL as Tier 3 (overlaps S7)
- **Fix**: see S7. Reclassify; drop Tier 1 vault count from 4 to 0 once context.tsx files are excluded; honest count.

### T4 — Major: setup.ts no `vi.unstubAllEnvs()`; env mutation leaks (overlaps S10)
- **Fix**: Add `afterEach(() => { vi.unstubAllEnvs(); })` to `setup.ts` as Batch P0 infra change before P1 starts. Test pattern docs: never `process.env.X = ...` directly.

### T5 — Major: page-route module-level Map state leaks across tests
- **Evidence**: `passkeyAuditEmitted` Map exported from page-route — `vi.clearAllMocks()` does not reset module state.
- **Fix**: Either (a) export `_resetPasskeyAudit()` test-only helper, called in beforeEach; or (b) use `vi.resetModules()` + dynamic import per test. Pick one in plan.

### T6 — Major: route-policy exhaustiveness must be type-driven
- **Evidence**: Hand-written `RoutePolicyKind` table silently passes when new kind added.
- **Fix**: Use `Record<RoutePolicyKind, TestCase[]>` so missing case is TS error at compile. Verify by deleting one entry and confirming `tsc --noEmit` fails.

### T7 — Major: P6 batch size + total PR scope
- **Evidence**: 90+ test files in one PR risks rubber-stamp review.
- **Fix**: "If branch exceeds 50 changed test files, split at next clean batch boundary into 2 PRs." Or alternatively: ship only Tier 1 (~45 files) in this branch and defer Tier 2 to follow-up.

### T8 — Minor: 3-file mutation check sample
- **Fix**: Either (a) per-file PR description note "what mutation in source would fail this test?", or (b) per-batch v8 branch coverage gate (every new test must cover ≥1 branch). Prefer (b) — automatable.

### T9 — Minor: Coverage delta unspecified
- **Fix**: Specify: "Before P1, run `npx vitest run --coverage --reporter=json` → `coverage/baseline.json`. After each batch, diff. Reject batch if any targeted file's lines-covered count did not strictly increase."

### T10 — Minor: Mock allowlist not structural
- **Fix**: Allowlist mockable modules in plan: `@/lib/prisma`, `next-intl`, `@/lib/http/with-request-log`, `node:fs/promises`, `@octokit/*`, `@aws-sdk/client-s3`, `next/headers`, `next-auth`. Anything else reviewed per-case.

### T11 — Minor: jsdom pragma per-file (depends on T1 resolution)
- **Fix**: If T1 resolves to "add jsdom", add to plan: "Each hook test gets `// @vitest-environment jsdom` first line. Global `environment: 'node'` unchanged."

### T12 — Minor: Tree-ified Zod errors couple to implementation
- **Fix**: Reword P3: "Assert `result.success === false` and presence of issues at expected `path`, not full `z.treeifyError()` tree shape. Use `result.error.issues.find(i => i.path[0] === 'fieldName')`."

### T13 — Minor: proxy.test.ts pruning step missing
- **Fix**: Final P1 step: "Audit `src/__tests__/proxy.test.ts` — remove cases now duplicated at gate level. Orchestrator file tests only orchestration (correct dispatch + ordering)."

### T14 — Minor: Tier 3 E2E coverage claim unverified
- **Fix**: Soften rationale to "deferred for batching, not because already covered." Propose follow-up branch name.

---

## Adjacent Findings
- F10 (Major) — routed to Security; addressed by S11
- S12 (Minor) — routed to Testing; addressed in T1 fix
- S13 (Minor) — routed to Testing; included in P5 instructions

---

# Round 2

## Changes from Previous Round
Plan rewritten to address all Round 1 Major findings: csrf-gate scope corrected (F1), inventory regenerated and `untested-app.txt` added (F2, F3), coverage-include consequence documented (F4), audit regression check added (F5), session-cache mock guidance added (F6), in-process wording fixed (F7), batch enumeration corrected (F8, F9), cross-tenant ownership assigned (F10/S11), token-replay tests added (S1), proxy-gate truth tables expanded (S2-S5), test-only export naming codified (S6), 5 *-context.tsx promoted to Tier 1.5 (S7/T3), AAD-substitution tests added (S8), max+1 rejection added (S9), env-var isolation enforced (S10/T4), security-bearing hooks RTL mandated (S12), no-secrets-in-error-messages added (S13), hooks moved to in-scope with jsdom+RTL infra (T1), pure-type files identified for skip (T2), module-state isolation pattern picked (T5), type-driven exhaustiveness specified (T6), PR-cap rule added (T7), per-batch v8 coverage-diff gate (T8/T9), mock allowlist codified (T10), per-file pragma rule (T11), Zod tree-shape decoupled (T12), proxy.test.ts pruning step added (T13), Tier 3 rationale softened (T14).

## Round 1 Resolution Status (all 10 F + 13 S + 14 T)
All Round 1 findings Resolved or Partially-resolved (S6 — convention codified, enforcement documented).

## Round 2 New Findings

### Functionality
- **F11 Major**: jsdom + @testing-library/* already in package.json — P0 should be "verify" not "add"
- **F12 Minor**: `_resetPasskeyAuditForTests` redundant with already-exported Map — fix is to make Map non-exported (overlaps S16)
- **F13 Minor**: baseline path inconsistent (coverage/ vs .coverage-baseline/)
- **F14 Minor**: coverage-diff.mjs design under-specified
- **F15 Minor**: Tier 1 "Lib vault (non-context) | 1" actually 0
- **F16 Minor**: P7 hook RTL-mandatory wording silent on non-security-bearing hooks

### Security
- **S14 Minor**: jsdom + @testing-library/* already installed (overlaps F11)
- **S15 Minor**: coverage-diff.mjs prototype-pollution defense (use bracket-access only)
- **S16 Major**: `passkeyAuditEmitted` Map currently directly exported — must be made module-private alongside adding `_resetPasskeyAuditForTests` (otherwise the parallel surface remains a security boundary leak)
- **S17 Minor**: `node:crypto` allowlist trap — partial mocks silently disable AES; allow only `vi.spyOn(...,'randomBytes')`
- **S18 Minor**: `@simplewebauthn/server` allowlist over-broad — must NOT be mocked when testing the WebAuthn handlers themselves
- **S19 Minor**: jsdom Web Crypto completeness must be verified in P0 before P5/P6/P7 rely on it
- **S20 Minor**: setup.ts env-write rule contradiction — direct `process.env.X = ...` permitted in setup.ts only

### Testing
- **T15 Major**: PR cap headroom too tight (77/80) — pre-declare 2-PR split (Tier 1 + Tier 1.5 vs Tier 2)
- **T16 Major**: coverage-diff baseline diff direction wrong (must be post-P<n-1> vs post-P<n>)
- **T17 Major**: v8 reporter doesn't emit per-file branch coverage in `--reporter=json` (need `coverage.reporter` + `coverage-final.json`)
- **T18 Major**: per-batch gate is local-only — document as developer discipline, not CI
- **T19 Major**: mock allowlist too restrictive for P4/P9 anchor-destinations
- **T20 Major**: jsdom Web Crypto completeness for P5/P6/P7 (overlaps S19)
- **T21 Minor**: `password-form-router.ts` slipped through as pure types (T2 partial)
- **T22 Minor**: P4 threshold rollback condition undefined
- **T23 Minor**: P9 mixed-env split needed
- **T24 Minor**: P0 baseline path/gitignore unclear
- **T25 Minor**: branch split protocol undefined

## Round 2 Resolution

All Major Round 2 findings applied via plan edits:
- F11/S14: P0 changed from "add" to "verify"; deps already in package.json
- F12/S16: page-route encapsulation refactor mandated in P1 (Map made module-private; only `_resetPasskeyAuditForTests`/`_passkeyAuditSizeForTests` and public `recordPasskeyAuditEmit` exposed; `proxy.test.ts` callers migrated)
- F13/T24: single path `.coverage-snapshots/post-P<n>.json` (gitignored, developer-local)
- F14/T16/T17/T18: coverage-diff redesigned — istanbul shape via `coverage.reporter=json`, post-P<n-1> vs post-P<n> diff, `--files` filter, ~50-80 LOC realistic, NOT CI-enforced (developer discipline tool)
- F15: Tier 1 "Lib vault (non-context)" row dropped (count was 0)
- F16: P7 RTL mandatory for ALL hooks (no escape hatch)
- T15: pre-declared 2-PR split: PR1 (Tier 1 + 1.5 + P0 = 45 files), PR2 (Tier 2 = 31 files)
- T19: anchor-destinations added to allowlist for `audit-anchor-publisher.ts` tests
- T20/S19: P0 jsdom Web Crypto probe test added — fails fast if HKDF/AES-GCM-256/12-byte-IV unsupported
- T21: `password-form-router.ts` dropped; hooks count 7→6, total 77→76
- T22: P4 rollback condition specified
- T23: P9 split into P9a (node) + P9b (jsdom)
- T25: PR-pair branch protocol specified
- S15: coverage-diff.mjs spec mandates bracket-access only
- S17: `node:crypto` allowlist tightened to `vi.spyOn(...,'randomBytes')` only
- S18: `@simplewebauthn/server` allowlist scoped
- S20: setup.ts env-write exception clarified

## Round 2 Status

23/23 new findings addressed. Plan locked at Round 2 final per user instruction "PRの手前まで確認することなくどんどん進めてください" (proceed without re-confirmation up to PR).

Remaining Minor items (none Critical/Major) tracked as in-implementation deviations rather than another full review round.

---

## Quality Warnings
None flagged.

---

## Recurring Issue Check

### Functionality expert
- R1 (uses `any`): Checked — no issue
- R2 (suppresses lint): Checked — no issue
- R3 (commits on main): Checked — no issue (branch from main)
- R4 (skips review findings): N/A — plan creation
- R5 (false technical justification): Checked — no issue
- R6 (write-read consistency / multi-agent gaps): Findings F2, F3
- R7 (ad-hoc workarounds): Checked — no issue
- R8 (acts without instruction): N/A — plan only
- R9 (run pre-pr.sh): Checked — Step 11 calls scripts/pre-pr.sh
- R10 (pull before branch): Checked — Step 1 cites `feedback_pull_before_branch.md`
- R11 (webhook dispatch design): N/A
- R12 (Tailwind palette): N/A
- R13 (skip build for test-only): Checked — plan still runs `next build` (correct per project)
- R14 (Japanese branch names): Checked — branch English
- R15 (amend pushed): Checked — new commits
- R16-R20: N/A or checked
- R21 (no personal email): Checked
- R22-R30: N/A or checked
- R31 (extension parallel impl): N/A
- R32 (plan edit location): Checked — under docs/archive/review/
- R33-R35: N/A or checked

### Security expert
- R1-R30: as above; main applicable findings via RS rules
- RS1 (do not mock crypto-server etc.): Findings S6 + S8
- RS2 (token validators include forged + expired + replay): Finding S1
- RS3 (proxy-gate tests deny path dominant): Findings S2, S3, S4, S5

### Testing expert
- R1-R35: N/A (not a code-edit task) or as documented above
- RT1 (jsdom env vs hook tests): Findings T1, T3
- RT2 (testable target?): Findings T2, T3, T1
- RT3 (decorative/flaky/slow patterns): Findings T4, T5, T6, T8, T12
