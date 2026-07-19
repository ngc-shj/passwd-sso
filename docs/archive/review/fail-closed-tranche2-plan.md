# Plan: fail-closed-tranche2 — Redis fail-closed contract tests (第2群) + class manifest + structural stub gate

Parent roadmap: `control-consolidation-roadmap-plan.md` Sec 1 (P1), as amended in
Review Rounds 1–3 (M2 actions 1/4/5, R3-1). Predecessor:
`fail-closed-tranche1-plan.md` (PR #680, merged) — its Scope contract SC1–SC4
defines this tranche's backlog. Deviation history that reshaped the backlog:
tranche-1 deviation log D8–D11 (AST classifier, three-mode gate,
legacy manifest). Plan review: `fail-closed-tranche2-review.md` — Round 1
findings M1–M11 / m12–m17 reflected below.

## Project context

- Type: `web app` (Next.js 16 App Router). This tranche touches test code, the
  shared fail-closed test helper (+ its self-test), the CI gate
  `check-fail-closed-routes-have-test.sh` + its self-test + the AST classifier
  (+ its self-test), three manifests under `scripts/checks/` (one new), three
  comment rewordings in src/lib, two small production route fixes
  (`v1/vault/status`, `v1/tags`), and two integration tests.
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest unit lane,
  db-integration lane via `vitest.integration.config.ts`, `scripts/checks/*`
  gates, meta-gate `check-gate-selftest-coverage.sh`).
- Verification environment constraints (inherited from parent plan):
  - VC3: Redis-failure fail-closed behavior is `verifiable-local` via mocked
    limiter in unit tests and via real broken-Redis simulation in the
    integration lane (`verifiable-CI` in ci-integration). C10's red-proof
    additionally requires a REACHABLE Redis (`REDIS_URL`); the test skips
    with the documented `redisAvailable` guard when absent (precedent:
    `admin-vault-reset-cross-tenant-sessions.integration.test.ts:35`).

## Objective

1. (SC4) Author the fail-closed contract test for every route remaining in
   `scripts/checks/fail-closed-test-debt.txt` (31 routes / 35 cases) using the
   existing `assertRedisFailClosed` helper, and burn the debt file down to 0.
2. (SC2) Pin the fail-closed class in a committed manifest with exact
   (path, count) set-equality (opt-in removal OR per-file limiter-count change
   forces a visible exemption diff), extend the gate enumeration to all of
   `src`, add the non-Response helper variant for the magic-link silent-drop
   contract, fix the two v1 routes that collapse `redisErrored` into 429, and
   define the migration policy for legacy-direct routes.
3. (SC1) Migrate the central-tree `rate-limit-audit` stubs (5 files) to
   limiter-layer mocks and add structural (AST) gate detection of the stub
   anti-pattern across ALL test files (parent R3-1), with a frozen exemption
   list.
4. (SC3, reduced) Add route-handler-level integration proof against real
   broken Redis for 2 representative route families.

## Ground truth (verified 2026-07-18 by 3-agent survey + Round 1 expert recomputation; line numbers as of main @ 136579ffb)

- Debt file has **31 entries** (not 24): tranche-1's AST reclassification (D9)
  moved 7 label-only routes back (rotate-master-key ×4, mcp/authorize,
  mobile/authorize, mobile/autofill-token). The debt file is the member-set
  SSoT for SC4.
- Gate model (three modes, AST-classified by
  `scripts/checks/classify-fail-closed-test.mjs`): helper / legacy
  (`fail-closed-legacy-direct.txt`, 13 routes) / debt. Failure tokens:
  MAPPING_MOCKED_CONTRACT_TEST, STALE_DEBT_ENTRY, STALE_LEGACY_ENTRY,
  LEGACY_DEBT_CONFLICT, LEGACY_TEST_MISSING, DANGLING_ENTRY,
  CLASSIFIER_FAILURE, MISSING_FAIL_CLOSED_TEST. AC4.4
  `EXPECTED_LIMITER_COUNT=69` (src/app/api only, test files included in the
  count — D4 trap); AC4.5 callsite floor 50.
- Classifier emits `exists/import/calls/mock/redis` per file; `mock=1` on
  `vi.mock("@/lib/security/rate-limit-audit")` (exact StringLiteral), a
  `checkRateLimitOrFail` property assignment, or a `mockCheckRateLimitOrFail`
  identifier. It classifies arbitrary files correctly — the gate merely never
  feeds it central-tree files outside the 2-path candidate derivation
  (`<dir>/route.test.ts`, `src/__tests__/api/<X>.test.ts`). That is the SC1
  structural hole. Known detection gaps (Round 1 M6): relative-path
  specifiers, `vi.doMock`, `vi.mock(import(...))`, template-literal
  specifiers, aliased `vi` — closed by C6.
- Helper `assertRedisFailClosed` (src/__tests__/helpers/fail-closed.ts):
  mandatory recorded `limiterFactory` with strict-identity attribution,
  required inline `failure` fixture literal, envelope `canonical | oauth |
  custom{status,body,retryAfter: required|forbidden|ignore}`, non-empty
  `assertNoMutation`, `snapshotFactory` for files that clear mocks.
- Out-of-scan members: the derivation grep
  (`grep -rn 'failClosedOnRedisError: true' src --include='*.ts' | grep -v src/app/api | grep -v test`)
  returns **6 files**: 3 production members —
  - `src/lib/security/rate-limiters.ts:19` `v1ApiKeyLimiter` — consumers:
    `v1/passwords` + `v1/passwords/[id]` (checkRateLimitOrFail, canonical,
    direct redisErrored tests exist); **`v1/vault/status/route.ts:39` and
    `v1/tags/route.ts:33` call `.check()` directly and collapse
    `redisErrored` into `rateLimited()` 429** — wrong envelope, no
    fail-closed audit emission (real gap).
  - `src/lib/scim/rate-limit.ts:17` — sole runtime caller
    `src/lib/scim/with-scim-auth.ts:30-36`: maps `redisErrored` →
    `scimError(503, "Service temporarily unavailable")` + explicit
    `emitRateLimitFailClosed`, **no Retry-After** (SCIM error envelope).
    `src/lib/scim/rate-limit.test.ts:33-38` covers redisErrored propagation
    (unit-level); **`src/lib/scim/with-scim-auth.test.ts:111-127` already has
    a redisErrored→503 test, but the file vi.mocks
    `@/lib/security/rate-limit-audit` at `:28`** (mocks `checkScimRateLimit`
    too) — the emit assertion runs against a stub, not the real module
    (Round 1 M2 correction).
  - `src/auth.config.ts:21` `magicLinkEmailLimiter` — `sendVerificationRequest`
    (`:113-121`) treats `redisErrored` identically to over-limit: `!rl.allowed`
    → warn log + silent return (**email not sent — fail-closed in effect, but
    undistinguished and untested**). `auth.config.test.ts:252-273` asserts only
    the factory option. No test invokes `sendVerificationRequest`.

  — and 3 comment-only literal occurrences (`src/lib/constants/audit/audit.ts:225`,
  `src/lib/security/ip-rate-limit.ts:20`, `src/lib/security/rate-limit-audit.ts:2`)
  which the C5 enumeration would misreport as members; C5 rewords them (D4
  precedent). Additional comment-only occurrences in non-test support files
  under `src/__tests__` (e.g. `helpers/fail-closed.ts`, `proxy/ast-guards.ts`)
  are excluded by C5's `src/__tests__` exclusion, not by rewording.
- Stub anti-pattern instances (complete enumeration, recomputed Round 1 —
  **19 test files**; C6 gate will enforce completeness at CI time):
  - colocated debt-route tests (un-stubbed by C2): rotate-master-key
    approve/execute/revoke/initiate + `execute-partial-failure.test.ts`,
    extension/bridge-code, mobile/authorize (`:73-75`, no rate-limit mock at
    all), mobile/autofill-token (`:25`, no rate-limit mock at all);
  - central tree (un-stubbed by C7 — 5 files): `src/__tests__/api/mcp/authorize.test.ts:45-48`,
    `extension/token-exchange-dpop.test.ts:48-50`,
    `token-refresh-cnfJkt.test.ts:53-55`,
    **`extension/bridge-code-cnfJkt.test.ts:45,59` (Round 1 M1)**,
    **`src/__tests__/db-integration/extension-token-dpop-flow.integration.test.ts:86` (Round 1 M1)**;
  - `extension/key-reset.test.ts:39-41` — un-stubbed by C2 row 10 (S,N), not
    C7 (Round 2 F-R2-2 attribution fix);
  - `src/lib/scim/with-scim-auth.test.ts:28` (un-stubbed by C8b; Round 1 M1);
  - legacy-manifest siblings (partial `importOriginal` form, exempt via C6
    frozen list) — tenant/members/[userId]/reset-vault (`:92`),
    tenant/operator-tokens (`:76`), tenant/scim-tokens (`:81`),
    tenant/service-accounts (`:70`).
- `extension/key/reset` has NO colocated test; its central test lives at
  `src/__tests__/api/extension/key-reset.test.ts`, which does NOT match the
  gate's alt-path derivation (`extension/key/reset.test.ts`) — a helper
  contract there would be invisible. Rename required.
- Legacy manifest (13 routes): all 13 sibling tests carry code-level
  `redisErrored`; 9 exercise the real mapping; 4 (tenant/*) partial-stub it.

### Member-set derivation (R42)

Class 第2群 = current content of `scripts/checks/fail-closed-test-debt.txt`
(31 entries), cross-checked against the defining primitive:

```
grep -rln 'failClosedOnRedisError: true' src/app/api | sort   # 62 files
comm -23 <(that list) <(helper-mode 18 ∪ legacy 13)            # = 31 debt
```

Verified Round 1: 62 = 18 ∪ 13 ∪ 31, no overlap, no residue; per-route table
matches the debt manifest exactly.

Whole-src member enumeration (C5 primitive):

```
grep -rln 'failClosedOnRedisError: true' src --include='*.ts' --include='*.tsx' \
  | grep -Ev '\.test\.tsx?$' | grep -v '^src/__tests__/'
```

→ after C5's comment rewording: exactly 65 files (62 route files + 3 lib
members).

Stub-instance member-set (C6 primitive): classifier `mock=1` over every
`\.test\.tsx?$` file under src (all lanes incl. db-integration) — 19 files
today, enumerated in Ground truth above.

Indirect members: consumers of `v1ApiKeyLimiter` (4 v1 route files import it;
route files themselves contain no flag literal and are NOT class members —
the member is `rate-limiters.ts`; consumer-level coverage is defined in C8).

**Per-route table (31 routes / 35 cases).** Columns: Env = envelope;
Refactor: S = remove `rate-limit-audit` stub, F = convert factory mock to
recording `vi.fn()`, M = per-limiter check-mock split via
`mockReturnValueOnce` chain, A = add missing `@/lib/security/rate-limit`
mock, U = un-mock `@/lib/security/ip-rate-limit`, N = rename central test to
gate-visible path.

**snapshotFactory mandate (Round 1 M10)**: required in EVERY file whose
`beforeEach` calls `vi.clearAllMocks()`/`vi.resetAllMocks()` — i.e. keyed on
the clear-hygiene grep, NOT on the F column. All 31 files currently clear
mocks; rows 10/17/20/26 (factory already recording, no F) still need
snapshotFactory at module scope right after the route import.

| # | Route (src/app/api/...) | Cases | Env | Refactor | assertNoMutation spies |
|---|---|---|---|---|---|
| 1 | admin/rotate-master-key/[rotationId]/approve | 1 | canonical | S,F | masterKeyRotation.updateMany |
| 2 | admin/rotate-master-key/[rotationId]/execute | 1 | canonical | S,F (both test files) | masterKeyRotation.updateMany, passwordShare.updateMany |
| 3 | admin/rotate-master-key/[rotationId]/revoke | 1 | canonical | S,F | masterKeyRotation.updateMany |
| 4 | admin/rotate-master-key/initiate | 1 | canonical | S,F | masterKeyRotation.create |
| 5 | auth/passkey/options/email | 1 | canonical | F | redis.set (challenge) — read-only route |
| 6 | auth/passkey/options | 1 | canonical | F | redis.set (challenge) — read-only route |
| 7 | auth/passkey/reauth/options | 1 | canonical | F | redis.set (challenge) — read-only route |
| 8 | emergency-access/accept | 1 | canonical | F (check is inline arrow → recording vi.fn) | emergencyAccessKeyPair.create, transition (svc) |
| 9 | extension/bridge-code | 2 | canonical | S,F,M,U — mockReturnValueOnce order: 1st = ipLimiter (route.ts:77), 2nd = bridgeCodeLimiter (:85); ip case requires a non-null client IP arrange (real checkIpRateLimit skips the limiter with `{allowed:true}` on null IP, ip-rate-limit.ts:52-59) | extensionBridgeCode.create, extensionBridgeCode.updateMany |
| 10 | extension/key/reset | 1 | canonical | S,N (→ src/__tests__/api/extension/key/reset.test.ts; factory already recording; snapshotFactory per M10) | extensionToken.updateMany |
| 11 | mcp/authorize | 1 | oauth | F (colocated) | validateOAuthRequest (svc; no-downstream-processing proxy — read-only route) |
| 12 | mcp/register | 1 | oauth | F | mcpClient.create, mcpClient.deleteMany |
| 13 | mcp/revoke | 1 | oauth | F | revokeToken (svc) |
| 14 | mobile/authorize | 1 | canonical | S,A,F | mobileBridgeCode.create |
| 15 | mobile/autofill-token | 1 | canonical | S,A,F | issueAutofillToken (svc) |
| 16 | share-links/[id]/content | 1 | canonical | F | prisma.$executeRaw (view-count), shareAccessLog.create |
| 17 | share-links/verify-access | 2 | canonical | (factory already recording; per-limiter mocks exist; snapshotFactory per M10) | createShareAccessToken (svc), passwordShare read — pre-auth `userId: null` path: production 503 emission is warn-log only, so no logAuditAsync collision (M9 rationale) |
| 18 | teams/invitations/accept | 1 | canonical | F | teamInvitation.updateMany, teamMember.upsert (tx) |
| 19 | tenant/access-requests | 2 (SA branch / session branch) | canonical | F | accessRequest.create (tx) |
| 20 | tenant/members/[userId]/reset-vault/[resetId]/approve | 2 (actor / target) | canonical | M (split shared check mock; creation order approveLimiter (:47) → approveTargetLimiter (:55); update existing chained tests; snapshotFactory per M10) | adminVaultReset.updateMany, createNotification |
| 21 | vault/change-passphrase | 1 | canonical | F | user.update, invalidateUserSessions (svc) |
| 22 | vault/delegation/check | 1 | custom `{authorized:false, reason:"service_unavailable"}` + retryAfter: required | F | delegationSession.findFirst — read-only route. NOT logAuditAsync: the production 503 path itself fires emitRateLimitFailClosed → logAuditAsync for authed users (rate-limit-audit.ts:240,:155) — spying it as "no mutation" races the intended emission (M9) |
| 23 | vault/delegation | 1 (POST) | canonical | F | delegationSession.create (tx), storeDelegationEntries (svc) |
| 24 | vault/rotate-key/data | 1 | canonical | F | passwordEntry.findMany, user.findUnique — read-only route |
| 25 | vault/rotate-key | 1 | canonical | F | $transaction/applyVaultRotation (svc), invalidateUserSessions (svc) |
| 26 | vault/unlock/data | 1 | canonical | (factory already recording; snapshotFactory per M10) | user.findUnique, vaultKey.findUnique — read-only route; arrange checkLockout=unlocked |
| 27 | webauthn/authenticate/options | 1 | canonical | F | redis.set (challenge), webAuthnCredential.findMany |
| 28 | webauthn/credentials/[id]/prf/options | 1 | canonical | F | redis.set (challenge), webAuthnCredential.findFirst |
| 29 | webauthn/credentials/[id]/prf | 1 | canonical | F | $transaction / webAuthnCredential.update (tx) — NOT logAuditAsync (same M9 rationale as #22) |
| 30 | webauthn/register/options | 1 | canonical | F | redis.set (challenge), webAuthnCredential.findMany |
| 31 | webauthn/register/verify | 1 | canonical | F | webAuthnCredential.create, redis.getdel, sendEmail |

Read-only-route semantics: `assertNoMutation` (non-empty, helper contract)
carries the nearest downstream side-effect/read primitives — documented here
so "no mutation" reads as "handler did not proceed past the limiter". This is
a documented semantic extension, not a helper change. Constraint (M9): a spy
may appear in `assertNoMutation` ONLY if the production 503 path itself never
invokes it — `logAuditAsync` is excluded on all post-auth rows because
`emitRateLimitFailClosed` calls it on the 503 path.

Pre-gate arrangement notes: #20 stub `requireRecentCurrentAuthMethod` → null
(step-up precedes limiter); #26 arrange `checkLockout` unlocked; #5/#6/#13/#16
run real `checkIpRateLimit` against the mocked limiter (#9 adds U);
#19's two cases arrange SA-bearer vs session auth contexts.

## Contracts

### C1 — Non-Response helper variant `assertRedisFailClosedSilentDrop`

- File: `src/__tests__/helpers/fail-closed.ts` (extend)
- Signature:

```ts
export async function assertRedisFailClosedSilentDrop(options: {
  /** Executes the non-Response producer (e.g. sendVerificationRequest). */
  invoke: () => Promise<unknown>;
  /** The mocked limiter under test — factory result object itself. */
  limiter: { check: Mock };
  /** Side-effect spies that MUST NOT fire (e.g. sendEmail). Non-empty. */
  assertNoEffect: readonly Mock[];
  /** Recorded factory mock; strict-identity attribution as in assertRedisFailClosed. */
  limiterFactory: Mock;
  /** Inline redisErrored fixture literal (gate literal must be code). */
  failure: RedisErroredFailure;
}): Promise<void>;
```

- Behavior: arrange `limiter.check.mockResolvedValue(failure)` → act →
  assert `limiter.check` called → assert every `assertNoEffect` spy
  `.not.toHaveBeenCalled()` (throw on empty array) → factory attribution
  identical to `assertRedisFailClosed` step 6 (strict identity, no fallback).
  No envelope assertions (the producer returns no Response — silent-drop
  contract).
- Invariants (app-enforced): variant never mocks
  `@/lib/security/rate-limit-audit`; empty `assertNoEffect` throws.
- Consumer-flow walkthrough: sole initial consumer is `src/auth.config.test.ts`
  (C8a), which supplies `invoke` = calling the captured
  `sendVerificationRequest` with a fixture email/url, `limiter` = the mocked
  magic-link limiter factory result, `assertNoEffect` = `[mockSendEmail]`,
  `limiterFactory` = recorded factory mock (snapshot-replayed), `failure` =
  inline literal. The variant returns void; the consumer reads nothing from
  it — violations surface as thrown expectation errors.
- Classifier note (Round 1 m17; SUPERSEDED by D10): originally the `calls`
  field counted only `assertRedisFailClosed`, so variant calls did not flip a
  file to helper mode and auth.config stayed legacy. The external-review
  follow-up (D10) generalized `calls` to all 3 helper tiers, so auth.config
  (silent-drop), SCIM (Response), and rate-limiters (direct-result) are now
  helper mode. SC-T3-6 is resolved in-tranche.
- Self-test (C7 extends `fail-closed.test.ts`): passing case; rejects when
  (a) effect spy fired, (b) empty `assertNoEffect`, (c) limiter never reached,
  (d) attributed factory call lacks the flag (incl. sibling-masking shape).

### C2 — Per-case fail-closed tests (35 cases across 31 files)

- Every case in the member-set table gets one test calling
  `assertRedisFailClosed` in the gate-visible sibling test (colocated
  `route.test.ts` for 30 routes; renamed
  `src/__tests__/api/extension/key/reset.test.ts` for #10).
- Refactor sub-tasks per the table's Refactor column (S/F/M/A/U/N), executed
  in the same file change. S-files: existing stub-driven `redisErrored` tests
  are REPLACED by the helper contract; other existing cases are restructured
  to limiter-layer mocks (default `{ allowed: true }`), keeping production
  `checkRateLimitOrFail` in path. Per-file notes recorded in the deviation
  log.
- Test names: `"fails closed (503, no mutation) when Redis is unavailable"`
  (suffix ` — <scope/branch>` for multi-case files).
- Acceptance criteria: `npx vitest run` green; each new test FAILS if the
  route's 503 envelope changes family or loses Retry-After (custom: per its
  policy), the guarded mutation/side-effect executes, the flag is removed
  from the limiter options, or the file re-introduces a mapping stub (C6
  gate + C4 grep).

### C3 — Debt-file burn-down (atomic, 31 → 0) + re-entry ratchet

- Remove all 31 entries in the same PR that adds the tests
  (STALE_DEBT_ENTRY enforces atomicity per route). The file remains in place
  (header + zero entries) as the registration target for future opt-ins.
- Re-entry ratchet (Round 1 m13): gate gains `EXPECTED_DEBT_COUNT=0` — a
  future debt entry requires editing the constant in the script (visible,
  reviewable diff), symmetric with AC4.4. Skipped under FIXTURE_ROOT
  overrides (same rule as AC4.4/AC4.5).
- Acceptance: `bash scripts/checks/check-fail-closed-routes-have-test.sh`
  passes; `EXPECTED_LIMITER_COUNT` stays 69 (C8c adds no new instantiation in
  src/app/api; the v1 fix adds `checkRateLimitOrFail` callsites only —
  AC4.5 floor 50 unaffected).

### C4 — Anti-pattern forbidden patterns (diff-scoped)

- pattern: `vi\.mock\("@/lib/security/rate-limit-audit"` in any file touched
  by this PR except the 4 legacy tenant/* siblings (untouched) — reason:
  RT5 mapping stub; C6 enforces the class structurally from now on.
- pattern: `checkRateLimitOrFail\s*:\s*vi\.fn` in the diff — reason: same
  anti-pattern via inline factory property.
- pattern: `success:\s*(true|false)` in fail-closed fixtures — reason: field
  does not exist on `RateLimitResult`.
- pattern: `redisErrored` inside comments/describe-labels as the only
  occurrence in a test file — reason: label-only references are the D9
  false-green class (classifier ignores them; don't reintroduce for humans).
- pattern: `failClosedOnRedisError` anywhere in `src/app/api/**/*.test.ts`
  diff hunks (Round 1 m16) — reason: AC4.4 counts the literal across ALL
  files under src/app/api including tests (D4 trap: one comment inflated the
  count to 70). The helper's factory attribution already verifies the flag;
  test files need the literal nowhere, not even in comments.

### C5 — Class manifest pinning + whole-src enumeration (M2 actions 1/4)

- New committed manifest `scripts/checks/fail-closed-manifest.txt`: one entry
  per line, format `path<TAB>count` (Round 1 M7) where `count` = expected
  number of `failClosedOnRedisError: true` instantiations in that file —
  65 entries (62 src/app/api route files + 3 lib members; exact list
  generated at implementation from the defining grep and cross-checked
  against the per-route table). Sorted by path; `#` comments and blanks
  skipped.
- Comment rewording sub-task (Round 1 M3): reword the flag literal out of the
  3 src/lib comment-only files (`src/lib/constants/audit/audit.ts:225`,
  `src/lib/security/ip-rate-limit.ts:20`,
  `src/lib/security/rate-limit-audit.ts:2`) — D4 precedent — BEFORE the gate
  extension lands, so enumeration = 65 exactly. Manifest header documents the
  D4 class rule (production comments must not contain the literal; the gate's
  text enumeration is fail-loud on violations).
- Gate extension (`check-fail-closed-routes-have-test.sh`):
  - Enumeration primitive (Round 1 M8 — whole src, not 3 hardcoded roots):
    `grep -rln 'failClosedOnRedisError: true' "$FIXTURE_ROOT/src" --include='*.ts' --include='*.tsx' | grep -Ev '\.test\.tsx?$' | grep -v '/src/__tests__/'`
    (also excludes `src/__tests__` non-test support files — helper/ast-guard
    comments live there). A future member anywhere under src (server actions,
    proxy, workers) is enumerated automatically.
  - Per-file count check (Round 2 S2-3 — AST-authoritative): the
    authoritative per-file count is computed by AST — `failClosedOnRedisError`
    PropertyAssignment with a TrueKeyword initializer inside a
    `createRateLimiter` argument object (extends the existing ts-morph
    tooling; `src/__tests__/proxy/ast-guards.ts` has the exact matcher
    precedent) — and must equal the manifest count, failure token
    `MANIFEST_COUNT_MISMATCH`. `grep -c` runs as cross-check: whenever
    grep-count > AST-count the file contains the literal in a comment/string
    — fail-loud token `MANIFEST_COMMENT_LITERAL` (enforces the D4 rule
    instead of documenting it; closes the "delete the real flag, add a
    comment with the literal" spoof that would otherwise leave a legacy
    member silently fail-open). Exact set equality on paths both directions:
    `MANIFEST_MISSING_ROUTE` (file opts in but absent from manifest) /
    `MANIFEST_STALE_ROUTE` (manifest entry no longer opts in / missing
    file). Removing a flag from ANY member — including the 2nd limiter of a
    multi-limiter file (count-neutral-swap evasion, M7) — now requires a
    same-PR manifest edit. DANGLING_ENTRY retained for debt/legacy
    manifests.
  - Sibling-test derivation for non-route members: `src/lib/<x>.ts` →
    `src/lib/<x>.test.ts`; `src/auth.config.ts` → `src/auth.config.test.ts`.
    Coverage modes unchanged (helper / legacy / debt) — the 3 members are
    registered in `fail-closed-legacy-direct.txt` (their siblings carry
    code-level `redisErrored` after C8; direct tests, pre-helper form).
  - AC4.4 retained unchanged (src/app/api aggregate 69) as a cross-check;
    the manifest's per-file counts are the authoritative granularity
    (sum over src/app/api manifest entries must equal
    EXPECTED_LIMITER_COUNT — asserted in the gate so the two primitives
    cannot drift apart silently).
  - Legacy ratchet (Round 1 M5; wording finalized Round 2 S2-5): the check
    is EXACT equality — `legacy entry count == EXPECTED_LEGACY_COUNT=16`
    (13 routes + 3 lib members after C8d). Growth AND shrink both require
    editing the constant in the same diff: growth is thereby
    review-blocking (closes the "license a new stub via legacy append"
    evasion), and migration PRs carry the constant decrement alongside the
    entry removal STALE_LEGACY_ENTRY already forces. No `<=` tolerance.
- Fixture-executability rules (Round 2 F-R2-1/S2-6 — the existing gate
  `exit 0`s at :244 under ANY override, which would make ratchet fixtures
  structurally unexecutable):
  - The new C5/C6 sections (manifest set-equality, per-file counts, stub
    scan) are placed BEFORE the AC4.4 early-exit and run in fixture mode —
    they are per-file checks, meaningful against fixture trees. ONLY
    repo-wide aggregate constants skip under overrides: AC4.4, AC4.5, and
    the manifest-sum==EXPECTED_LIMITER_COUNT cross-check (fixture manifests
    never sum to 69).
  - The ratchet constants become fixture-overridable:
    `EXPECTED_DEBT_COUNT="${FAIL_CLOSED_EXPECTED_DEBT_COUNT:-0}"`,
    `EXPECTED_LEGACY_COUNT="${FAIL_CLOSED_EXPECTED_LEGACY_COUNT:-16}"` — so
    red fixtures (1-entry debt file vs expected 0; 17-entry legacy vs 16)
    are executable.
  - EVERY new env override (`FAIL_CLOSED_TEST_MANIFEST_FILE`,
    `FAIL_CLOSED_EXPECTED_DEBT_COUNT`, `FAIL_CLOSED_EXPECTED_LEGACY_COUNT`)
    is added to BOTH guard sites in the same edit: the ENV_POLLUTION_GUARD
    variable list (gate :63-70) AND the aggregate-skip condition (:244) —
    a stray override under CI=true must refuse to run (sec-F6 rule).
- Order-of-work invariant (app-enforced, per tranche-1 trap): extend
  `scripts/__tests__/check-fail-closed-routes-have-test.test.mjs` with red
  fixtures for the new tokens (MANIFEST_MISSING_ROUTE, MANIFEST_STALE_ROUTE,
  MANIFEST_COUNT_MISMATCH via a 2-limiter fixture file with a count-1
  manifest entry, MANIFEST_COMMENT_LITERAL via a flag-in-comment fixture,
  MANIFEST_PARSE_ERROR via malformed lines — missing tab / non-numeric
  count (Round 2 F-R2-4), debt ratchet via env override, legacy ratchet via
  env override) BEFORE modifying the gate script; meta-gate
  `check-gate-selftest-coverage.sh` must stay green (both scripts already
  have sibling self-tests — no debt entries added).
- Consumer-flow walkthrough (manifest consumed by the gate script): gate
  parses `path<TAB>count` lines (comments/blank skipped; malformed line —
  missing tab or non-numeric count — is a fail-loud `MANIFEST_PARSE_ERROR`),
  compares paths via membership and counts via per-file grep -c. The gate is
  the sole consumer; format documented in the manifest header.

### C6 — Structural stub-detection gate (SC1 / parent R3-1)

- Gate extension: a fourth section in `check-fail-closed-routes-have-test.sh`
  enumerates ALL test files under src across BOTH lanes — pattern
  `\.test\.tsx?$` (Round 1 M4: includes `.test.tsx`, top-level
  `src/*.test.ts` like `auth.config.test.ts`, and `src/__tests__/db-integration/*.integration.test.ts`)
  — PLUS the vitest `setupFiles` entries from both vitest configs (a mock
  in setup applies to every test). Two-phase enumeration (Round 1 M11):
  under a FIXTURE_ROOT override use
  `find "$FIXTURE_ROOT/src" -name '*.test.ts' -o -name '*.test.tsx'` (temp
  fixture trees are not git repos); without overrides use
  `git ls-files 'src' | grep -E '\.test\.tsx?$'` (pathspec `'src'` recurses;
  the `'src/**/*.test.ts'` form misses top-level files). Batch-feed to the
  classifier; `mock=1` → failure token `STUB_MOCKED_RATE_LIMIT_AUDIT: <file>`
  UNLESS the file is in the frozen exemption list.
- Frozen exemption list (Round 1 M5): hardcoded in the gate script — exactly
  the 4 tenant/* legacy sibling test files (reset-vault, operator-tokens,
  scim-tokens, service-accounts `route.test.ts` paths). NOT derived from the
  legacy manifest: legacy membership must not license new stubs, and the 9
  clean legacy siblings must stay stub-free. Removing an exemption line
  (tranche-3 migration) is a visible script diff.
- Classifier hardening (Round 1 M6 + Round 2 S2-1/S2-2, red fixtures per
  variant FIRST in `scripts/__tests__/classify-fail-closed-test.test.mjs`):
  - Specifier match: normalize the first arg (strip `.ts`/`.js` extension;
    resolve relative specifiers against the test file's directory) and match
    on suffix `lib/security/rate-limit-audit` — catches
    `../../../lib/security/rate-limit-audit` and alias forms alike.
  - Callee forms: `vi.mock` AND `vi.doMock`; first arg StringLiteral,
    NoSubstitutionTemplateLiteral, or `import("<specifier>")` CallExpression
    (vitest 3 typed form).
  - Non-literal specifier = fail-loud, not silent pass (Round 2 S2-2): a
    `vi.mock`/`vi.doMock` whose first arg is none of the recognized literal
    forms (e.g. a variable or `"a" + "b"` concatenation) emits a new
    failure token `STUB_DYNAMIC_SPECIFIER` — legitimate tests never need
    dynamic mock specifiers, so the false-positive cost is zero, and the
    computed-property-factory evasion dies with it.
  - `vi` resolution is RECALL-first for the mock fail-criterion (Round 2
    S2-1 — both vitest configs run `globals: true`, so a file with no
    vitest import legitimately uses global `vi`; D11's precision-first
    symbol binding would classify its stub as mock=0, a REGRESSION from the
    current text match). Counted callee roots: (a) the `vitest`
    named-import binding (alias-aware), (b) a bare `vi` identifier with NO
    local declaration (the global), (c) `<vitest-namespace>.vi` from
    `import * as V from "vitest"`. A locally-declared `vi` shadow is
    fail-loud (suspicious construct), never a silent pass. D11's
    precision-first rule continues to apply ONLY to the `calls`
    pass-criterion, where a miss is fail-loud by design. Red fixtures per
    shape: global-vi stub, namespace-vi stub, shadowed-vi.
  - `.tsx` inputs get a `.tsx` virtual path in the in-memory project so JSX
    parses (classifier currently pins `.ts` — would CLASSIFIER_FAILURE on
    JSX, Round 1 M4/F5).
- Config-seam guard (Round 2 S2-4/F-R2-3): the gate additionally (a) greps
  `vitest.config.ts` + `vitest.integration.config.ts` for
  `rate-limit-audit` — ANY hit is fail-loud (token `STUB_CONFIG_SEAM`),
  closing the `resolve.alias` redirect evasion; (b) derives the setupFiles
  scan list FROM those configs (grep the `setupFiles` entries' path
  literals), so a third setup file cannot be added outside the scan.
  FIXTURE_ROOT behavior: read `$FIXTURE_ROOT/vitest*.config.ts` when
  present, else empty setup list. Red fixtures: fixture config +
  stub-bearing setup file → STUB_MOCKED_RATE_LIMIT_AUDIT; fixture config
  with a rate-limit-audit alias → STUB_CONFIG_SEAM.
- Self-test red fixtures FIRST (same order-of-work invariant as C5): central
  non-sibling stub → fails; top-level `src/x.test.ts` stub → fails; `.test.tsx`
  stub → fails; relative-specifier stub → fails; `vi.doMock` → fails;
  exempt-list file stub → passes; stub removed → passes.
- Post-migration expected state: exactly the 4 frozen exemptions hit;
  every other `mock=1` occurrence (per the 19-file Ground-truth enumeration)
  is removed by C2/C7/C8b in this PR.
- Acceptance: a NEW `vi.mock`/`vi.doMock` of rate-limit-audit anywhere under
  src (any lane, any extension) fails CI unless the frozen list is edited —
  the R3-1 "convention only" gap is closed.

### C7 — Central-tree stub migration (SC1)

- `src/__tests__/api/mcp/authorize.test.ts`: remove the rate-limit-audit stub
  (`:45-48`); rate-limit neutralized at limiter layer (`{ allowed: true }`).
  The stub-driven `redisErrored fail-closed` describe (`:345-384`) is DELETED
  — ownership moves to the colocated helper contract (#11). Non-rate-limit
  coverage (OAuth validation, anti-enumeration, redirects, locale, passkey
  matrix) is preserved unchanged.
- `src/__tests__/api/extension/token-exchange-dpop.test.ts` (`:48-50`),
  `token-refresh-cnfJkt.test.ts` (`:53-55`), and
  `bridge-code-cnfJkt.test.ts` (`:45,59` — Round 1 M1): remove the stubs;
  the existing `createRateLimiter` factories gain a default
  `{ allowed: true }` check resolution so DPoP/cnf-jkt cases run with the
  production mapping in path. No fail-closed claims exist in these files —
  none are added (fail-closed contracts live in the colocated tests).
- `src/__tests__/db-integration/extension-token-dpop-flow.integration.test.ts`
  (`:86` — Round 1 M1): same un-stub (limiter-layer `{ allowed: true }`
  mock); the integration lane is inside C6's scan universe by design.
- `execute-partial-failure.test.ts` (rotate-master-key execute sibling):
  un-stub identically (S refactor; counted under C2 table row 2).
- Helper self-test extension for C1 (cases (a)–(d)).
- Acceptance: `git grep -lE 'vi\.(mock|doMock)\("@/lib/security/rate-limit-audit"' -- 'src'`
  returns exactly the 4 frozen tenant/* siblings; C6 gate green.

### C8 — Out-of-scan member coverage + v1 envelope fix (M2 action 4)

- **C8a magic-link silent-drop contract**: `src/auth.config.test.ts` gains a
  test that captures `sendVerificationRequest` from the provider config,
  mocks `createRateLimiter` with a recording factory (+ snapshotFactory),
  mocks `@/lib/email/send` — and calls `assertRedisFailClosedSilentDrop`
  with `assertNoEffect: [mockSendEmail]` and the inline `failure` literal.
  Also asserts the drop is logged (`getLogger().warn` spy — constant string
  `"magic-link.rate-limited"`, no PII) — observability floor for an
  otherwise-silent path. Production `sendVerificationRequest` code is NOT
  changed (silent drop is the documented anti-enumeration contract).
- **C8b SCIM 503 mapping contract** (rewritten per Round 1 M2/M1):
  `src/lib/scim/with-scim-auth.test.ts` currently vi.mocks BOTH
  `@/lib/scim/rate-limit` AND `@/lib/security/rate-limit-audit` (`:28`) and
  its existing redisErrored test (`:111-127`) asserts a stubbed emit. Rework:
  (1) REMOVE the rate-limit-audit module mock (C6 compliance — the file is
  not exempt); (2) un-mock `checkScimRateLimit`, mocking at the
  `createRateLimiter` layer instead (recording factory + snapshotFactory —
  the SCIM limiter is module-scoped in rate-limit.ts); (3) rebuild the
  existing :111 test as the direct contract: `authorizeScim` returns
  `{ ok: false, response }` with status 503 + SCIM error envelope, tenant
  lookup spies not called; (4) emission observed on the REAL module surface
  with the seam pinned (Round 2 F-R2-5): `vi.mock("@/lib/audit/audit")`
  exporting spied `logAuditAsync` AND `tenantAuditBase` (legal — C6 bans
  only rate-limit-audit mocks), asserted via
  `vi.waitFor(() => expect(logAuditAsync).toHaveBeenCalledWith(expect.objectContaining({ action: RATE_LIMIT_FAIL_CLOSED, targetId: "scim" })))`
  — the warn-log branch is UNREACHABLE here (SCIM passes non-null tenantId,
  rate-limit-audit.ts:143-148), so a log spy would be a dead assertion;
  (5) throttle hygiene (Round 2 F-R2-2): `beforeEach` calls the existing
  `__resetThrottleForTests()` (rate-limit-audit.ts test-only export) —
  `emitRateLimitFailClosed` throttles per key
  (`rlfc:scim:<userId ?? ip-bucket>`, 5-min window, module-scoped Map);
  without the reset, a prior test's emission silently swallows the asserted
  one (order-dependent vi.waitFor timeout). Same mandate applies to ANY
  file asserting real emission. `rate-limit.test.ts:33-38`
  propagation test stays (legacy-mode `redis=1` anchor for the member file).
  Retry-After is documented-absent (SCIM envelope); adding it is out of
  scope (SC-T3-2).
- **C8c v1 envelope fix (production)**: `v1/vault/status/route.ts` and
  `v1/tags/route.ts` replace direct `.check()` + `rateLimited()` with
  `checkRateLimitOrFail({ req, limiter: v1ApiKeyLimiter, key, scope: "v1.vault_status" | "v1.tags", userId, tenantId })`
  (canonical envelope; `req` required by `CheckRateLimitOrFailArgs` — Round 1
  m12) — behavior change: Redis outage now returns 503 + Retry-After +
  fail-closed audit emission instead of a bare 429, matching the two
  v1/passwords routes (M2's class contract). 429 path unchanged. Both
  colocated tests gain helper contract tests. Mock topology (Round 1 m12):
  mock `@/lib/security/rate-limit` (`createRateLimiter`) with a recording
  factory and keep `@/lib/security/rate-limiters` REAL so `v1ApiKeyLimiter`
  is the factory's recorded result (strict-identity attribution works);
  snapshotFactory at module scope (module-load instantiation +
  clearAllMocks). Spies: the routes' entry/tag reads.
- **C8d legacy registration**: add the 3 member files to
  `fail-closed-legacy-direct.txt` (their siblings satisfy legacy mode with
  code-level `redisErrored` after C8a/C8b; `rate-limiters.test.ts` already
  qualifies) and set `EXPECTED_LEGACY_COUNT=16`. LEGACY_DEBT_CONFLICT
  impossible (never in debt file).
- Acceptance: gate green with whole-src enumeration; the two v1 routes' new
  tests FAIL if the envelope regresses to 429-on-redisErrored; C6 reports
  zero non-exempt stubs.

### C9 — Migration policy for already-tested routes (M2 action 5)

- Documented in the legacy manifest header + this plan (gate backing:
  STALE_LEGACY_ENTRY + EXPECTED_LEGACY_COUNT ratchet from C5):
  1. Legacy entries are a frozen set; new entries are prohibited except
     scan-root onboarding performed here (C8d). Growth is blocked by the
     EXPECTED_LEGACY_COUNT constant (script edit = review-blocking diff).
  2. Any PR that touches a legacy route's rate-limit wiring OR its sibling
     test's rate-limit mocks MUST migrate that route to helper mode in the
     same PR (remove the legacy entry + lower the constant;
     STALE_LEGACY_ENTRY backs this).
  3. The 4 tenant/* partial stubs are tolerated solely via the C6 frozen
     exemption list; their migration (stub removal + helper contract) is the
     bulk of tranche 3 (SC-T3-1).
  4. Target end-state (Round 1 m17; updated by D10): all 13 legacy ROUTE
     entries migrate to helper mode and the C6 exemption list empties with
     them (tranche 3, SC-T3-1). The 3 lib members were migrated to helper mode
     in-tranche (D10, SC-T3-6 resolved) and removed from legacy — so the legacy
     file now holds exactly the 13 ROUTE members (EXPECTED_LEGACY_COUNT=13).

### C10 — Route-handler-level integration proof (SC3, reduced)

- File: `src/__tests__/db-integration/rate-limit-fail-closed-routes.integration.test.ts` (new)
- Real broken Redis (ioredis at 127.0.0.1:1, `enableOfflineQueue:false`,
  `retryStrategy:null`, `connectTimeout:100` — chain-test precedent), real DB,
  NO mocks of rate-limit / rate-limit-audit. `@/lib/redis`'s `getRedis` mock
  returns a switchable client (broken ↔ real from `REDIS_URL`) — sound
  because `createRateLimiter` calls `getRedis()` per check
  (rate-limit.ts:54; Round 1 adjudication of Func-A1).
- Two representative families (both pre-auth, minimal fixtures):
  1. `POST /api/mcp/register` (oauth envelope; limiter precedes body parse,
    route.ts:67-80): broken Redis → 503 `{error:"temporarily_unavailable"}`
    + Retry-After, and `mcpClient` row count unchanged (real-DB no-mutation
    proof).
  2. `POST /api/share-links/verify-access` (canonical; valid JSON body
    required — parse precedes the limiter): broken Redis → 503
    `SERVICE_UNAVAILABLE` + Retry-After; `shareAccessLog` count unchanged.
    Coverage claim (Round 1 m15): this proves the FIRST gate (ipLimiter)
    fail-closed end-to-end; the token limiter is structurally unreachable
    under a whole-Redis outage (ip 503 short-circuits at route.ts:51-57) and
    stays covered by C2 unit contracts — residual noted under SC-T3-4.
- Red-proof (RT7): same handlers with the real Redis client proceed past the
  limiter (assert non-503 status, e.g. 400/404 domain error) — proves the
  503 discriminates on Redis failure, not on fixtures. Guarded by
  `redisAvailable = !!process.env.REDIS_URL` skip (precedent:
  admin-vault-reset-cross-tenant-sessions.integration.test.ts:35); the
  broken-Redis cases run regardless.
- Throttle hygiene (Round 2 F-R2-2, applies to any real-emission assertion):
  because this lane runs the REAL `emitRateLimitFailClosed`, if a later
  assertion inspects emission it must `__resetThrottleForTests()` in
  `beforeEach`; the two families here assert row-count/status (not emission)
  so the module-scoped throttle is inert, but the reset is added defensively
  to keep per-test isolation.
- Scope note: remaining families stay covered by C2 (production mapping in
  path) + the tranche-1 chain proof; further families deferred (SC-T3-4).

## Testing strategy

- `npx vitest run` (35 C2 cases + C1/C7 helper self-tests + C8 cases +
  existing suites; gate self-test + classifier self-test via vitest lane
  `scripts/__tests__/*`).
- `npm run test:integration` (C10 + existing; requires local Postgres;
  red-proof cases additionally need `REDIS_URL`, else skipped).
- `bash scripts/checks/check-fail-closed-routes-have-test.sh` (C3/C5/C6/C8).
- `bash scripts/checks/check-gate-selftest-coverage.sh` (meta-gate, C5/C6).
- `npx next build` (C8c touches production routes).
- `scripts/pre-pr.sh` before PR.

## Considerations & constraints

### Scope contract

- SC-T3-1: legacy-manifest burn-down (13 routes → helper mode, incl. the 4
  tenant/* stub removals + C6 frozen-exemption emptying) — owner: tranche 3.
- SC-T3-2: SCIM 503 Retry-After header addition (envelope change, SCIM RFC
  7644 error shape review needed) — owner: future SCIM hardening.
- SC-T3-3: v1/passwords + v1/passwords/[id] direct redisErrored tests →
  helper-mode migration (policy C9.2 triggers it when touched) — owner:
  tranche 3.
- SC-T3-4: route-handler integration for remaining families beyond C10's two,
  incl. the verify-access token-limiter case (unreachable under whole-outage;
  would need a selectively-failing Redis fake) — owner: tranche 3 (promote
  only if C10 pattern proves cheap).
- SC-T3-5: `magicLinkEmailLimiter` redisErrored observability upgrade
  (distinguish outage from over-limit in the warn log / metrics) — owner:
  future observability pass; current silent-drop contract is preserved
  as-is.
- SC-T3-6: classifier awareness of `assertRedisFailClosedSilentDrop` as a
  helper call (enables helper mode for non-Response members; prerequisite
  for retiring the 3 lib members' legacy entries) — **RESOLVED in-tranche**
  (external-review follow-up, deviation D10): classifier now recognizes all 3
  helper tiers (Response / silent-drop / direct-result via the new
  `assertRedisFailClosedResult`); all 3 lib members migrated to helper mode
  and removed from legacy (EXPECTED_LEGACY_COUNT 16→13).

### Risks

- Un-stubbing mobile/autofill-token (`:23-24` comment: stub kept prisma out
  of the module graph) may surface import-time coupling — mitigation:
  `@/lib/prisma` is already vi.mocked in that file; verify on the first
  converted file before fanning out (tranche-1 extension/token precedent).
- C6's `git ls-files` phase misses untracked new test files during local
  dev — acceptable: CI runs on committed trees; pre-pr runs after `git add`.
  The FIXTURE_ROOT phase uses `find` and has no such gap (documented in the
  gate comment).
- C8c is a user-visible behavior change on two v1 endpoints (429 → 503 during
  Redis outage). Pre-1.0, matches the documented class contract and the
  sibling v1/passwords behavior; changelog entry via conventional commit.
- 31-file mechanical fan-out risks drift — mitigation: batch implementation
  with per-batch `vitest related` runs + the C4 grep + final full suite, per
  tranche-1 batching precedent.
- The C5 manifest format change (path<TAB>count) is a NEW file, not a
  migration of debt/legacy formats — the existing `read_manifest` /
  `grep -qxF` machinery for debt/legacy stays untouched (no cross-format
  regression surface).
- Accepted residual (Round 2 S2-7): C5's enumeration excludes
  `src/__tests__` entirely (necessary — helper/ast-guards support files
  carry code-level flag occurrences). A flag-bearing limiter defined in a
  non-test support file there and imported by production code would escape
  pinning. Low realism (production importing from `src/__tests__` is
  itself a review-visible smell); accepted, not gated.

## User operation scenarios

- Operator during a Redis outage: every 第2群 endpoint (incl. WebAuthn
  options/verify, share-link access, delegation, admin key-rotation) returns
  the documented 503 envelope with Retry-After (custom shape only for
  delegation/check); no credential registered, no share content served, no
  vault key rotated, no token minted. v1 API-key clients now receive 503
  (previously a misleading 429) on `vault/status` and `tags`. Magic-link
  requesters receive the normal "check your email" UX while no email is sent
  (anti-enumeration preserved); admins see the warn log.
- Developer adding a new fail-closed limiter anywhere under src: CI demands
  (1) a manifest entry with the exact per-file count, (2) a helper contract
  test or debt entry (debt requires bumping EXPECTED_DEBT_COUNT — visible),
  and rejects any new `rate-limit-audit` stub anywhere in the test tree.
- Developer removing `failClosedOnRedisError: true` (or one instantiation of
  it) from any file: CI fails until the manifest count/entry (and debt/legacy
  files) are edited in the same PR — the removal is always a reviewable diff.

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|----------------------------------------------------------------|--------|
| C1  | Non-Response helper variant assertRedisFailClosedSilentDrop    | locked |
| C2  | 35 per-case fail-closed tests across 31 files (S/F/M/A/U/N refactors) | locked |
| C3  | Debt-file burn-down 31 → 0, atomic + EXPECTED_DEBT_COUNT=0     | locked |
| C4  | Anti-pattern forbidden patterns (incl. test-file flag-literal guard) | locked |
| C5  | Class manifest (path+count, AST-authoritative) + whole-src enumeration + ratchets + config-seam guard | locked |
| C6  | Structural stub gate (frozen exemptions, recall-first vi resolution, dynamic-specifier fail-loud) | locked |
| C7  | Central-tree stub migration (5 files + execute-partial-failure)| locked |
| C8  | Out-of-scan member coverage + v1 envelope fix (throttle-reset pinned) | locked |
| C9  | Legacy migration policy                                        | locked |
| C10 | Route-handler integration proof (2 families, red-proven)       | locked |

## Implementation Checklist (Phase 2-1)

### CI parity
- `check-fail-closed-routes-have-test.sh` and `check-gate-selftest-coverage.sh`
  both run in `scripts/pre-pr.sh` (:164, :198) and are within the CI gate set
  (extract-ci-checks: 13 gates, all pre-pr subset). No parity gap.
- Both modified scripts already have sibling self-tests → meta-gate satisfied,
  no gate-selftest-debt entries.

### Reusable assets (must reuse, not reimplement)
- `assertRedisFailClosed` + `snapshotFactory` (src/__tests__/helpers/fail-closed.ts) — C1 extends this file.
- `__resetThrottleForTests` (rate-limit-audit.ts:264), `AUDIT_ACTION.RATE_LIMIT_FAIL_CLOSED`, `logAuditAsync`/`tenantAuditBase` (src/lib/audit/audit.ts) — C8b.
- AST matchers `parseRouteSource` / `hasCallWithObjectFlag` / object-flag helpers (src/__tests__/proxy/ast-guards.ts) — precedent for C5 AST per-file count.
- ts-morph in-memory project pattern (classify-fail-closed-test.mjs) — C6 classifier hardening extends this.
- Gate seams: ENV_POLLUTION_GUARD (check-fail-closed-routes-have-test.sh:63-70), aggregate-skip (:244), read_manifest/grep -qxF (:75-98) — reuse for the manifest override.

### Files to modify/create
- CREATE: scripts/checks/fail-closed-manifest.txt (path<TAB>count, 65 entries)
- MODIFY: scripts/checks/check-fail-closed-routes-have-test.sh (C3 ratchet, C5 manifest+whole-src+config-seam, C6 stub scan)
- MODIFY: scripts/checks/classify-fail-closed-test.mjs (C6 hardening: recall-first vi, doMock, dynamic-specifier fail-loud, .tsx virtual path)
- MODIFY: scripts/__tests__/check-fail-closed-routes-have-test.test.mjs (red fixtures FIRST)
- MODIFY: scripts/__tests__/classify-fail-closed-test.test.mjs (classifier red fixtures FIRST)
- MODIFY: src/__tests__/helpers/fail-closed.ts (C1 variant) + fail-closed.test.ts (C1 self-test)
- MODIFY: 31 route.test.ts (C2) + key-reset rename (#10) + 5 central stubs (C7) + execute-partial-failure
- MODIFY: src/lib/scim/with-scim-auth.test.ts (C8b), src/auth.config.test.ts (C8a)
- MODIFY: src/app/api/v1/vault/status/route.ts + route.test.ts, src/app/api/v1/tags/route.ts + route.test.ts (C8c)
- MODIFY: scripts/checks/fail-closed-test-debt.txt (31→0, C3), fail-closed-legacy-direct.txt (+3, C8d)
- MODIFY: 3 src/lib comment rewordings (C5: audit.ts:225, ip-rate-limit.ts:20, rate-limit-audit.ts:2)
- CREATE: src/__tests__/db-integration/rate-limit-fail-closed-routes.integration.test.ts (C10)
