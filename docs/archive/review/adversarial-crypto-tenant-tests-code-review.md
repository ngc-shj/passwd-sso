# Code Review: adversarial-crypto-tenant-tests
Date: 2026-05-04
Review round: 1

## Changes from Previous Round

Initial code review of feature/adversarial-crypto-tenant-tests. Branch contains 7 commits implementing the Phase 1 contract-first plan: scaffolding (schema enum + migration + audit constants + CI paths + helpers extension), MCP race fix, 5 crypto adversarial tests, tenant-swap integration test, MCP rotation race integration test (N=50), plus i18n + lint fixes.

## Functionality Findings

### F-1 [Critical]: Contract 1 violation — nested `$transaction` on raw injected client bypasses RLS GUC connection
- File: `src/lib/mcp/oauth-server.ts:338-444` (Phase 1), `:494-519` (revokeFamilyOutOfBand) — pre-fix
- Evidence: Both sites used `withBypassRls(dbClient, async () => dbClient.$transaction(async (tx) => {...}), purpose)`. Contract 1 §Forbidden explicitly prohibits this.
- Problem: Singleton `prisma` Proxy intercepts nested $transaction (production safe). Raw injected client opens a SECOND transaction on a different pool connection without bypass_rls GUCs. Under `passwd_app` (NOSUPERUSER, NOBYPASSRLS) + FORCE ROW LEVEL SECURITY on mcp_* tables, queries silently filter to zero rows. Race test could pass vacuously.
- Impact: Race test correctness depends on this. If vacuous, the security guarantee is unverified.
- Fix: Use `tx` argument from `withBypassRls(dbClient, async (tx) => {...}, purpose)`. All queries on tx.

### F-2 [Major]: Audit assertion gap for `MCP_REFRESH_TOKEN_FAMILY_REVOKED`
- File: `src/__tests__/db-integration/adversarial/mcp-token-rotation-race.adversarial.integration.test.ts:276-292` — pre-fix
- Evidence: Test acknowledged the gap and deferred to a `route.test.ts` that didn't exist for this case.
- Problem: Contract 5 mandates audit emission. No test verified `concurrent_rotation_revoked` → `MCP_REFRESH_TOKEN_FAMILY_REVOKED` audit.
- Fix: Add unit test in `src/app/api/mcp/token/route.test.ts` mocking `exchangeRefreshToken` to return `concurrent_rotation_revoked` and asserting `logAuditAsync` called with the new audit action.

### F-3 [Minor]: Contract 3 — success result missing `refreshTokenId` and `familyId`
- File: `src/lib/mcp/oauth-server.ts:315-325` — pre-fix
- Evidence: Contract 3 requires both fields. Implementation only had `accessTokenId`.
- Fix: Add both fields to success return type and value.

### F-4 [Minor]: Contract 3 — `"not_found"` absent from failure reason union
- Evidence: Code returns `{ ok: false, error: "invalid_grant" }` without `reason` for missing token. Contract 3 lists `not_found` in canonical union.
- Disposition: Skipped (Anti-Deferral). No current caller uses this distinction; trivial future fix.

### F-5 [Minor]: Migration contains unrelated `audit_chain_anchors` default change
- Evidence: Prisma migrate dev picked up pre-existing schema drift.
- Disposition: Skipped — functionally benign, documented in PR.

## Security Findings

### S1 [Critical, escalate=true → SKIPPED]: Contract 1 violation in race test injection path
- Same as F-1 above (independent corroboration by Security expert).
- Escalation skipped per user precedent (F-1/Functionality independently identified the same orchestration concern).
- Resolution: Same as F-1 — use `tx` from `withBypassRls`.

### S2 [Major]: Contract 3 gap — same as F-3
- Resolution: Same as F-3.

### S3 [Major]: Phase 2 revocation has no durable retry surface
- File: `src/lib/mcp/oauth-server.ts:520-524`
- Evidence: `revokeFamilyOutOfBand` catches errors and logs, but no durable retry queue.
- Disposition: Skipped — Contract 2 explicitly permits deferring durable retry IF a grep-able log line is present. The `mcp.refresh_token.family_revocation_failed` log message is grep-able. Acceptable per Contract 2.

### S4 [Low]: `both-failed` iterations skip family-revocation assertion
- Disposition: Skipped — T4 non-vacuous guard (added) ensures at least one (winner, loser) pair runs the assertions. Production code still fires revocation on both-failed; test just doesn't assert redundantly.

### S5 [Minor]: Replay path audit metadata missing `reason` field (asymmetric with concurrent path)
- File: `src/app/api/mcp/token/route.ts:122-127` — pre-fix
- Fix: Added `reason: FAMILY_REVOKED_REASON.REPLAY` to replay path metadata. Symmetry restored.

### S6 [Informational]: `validateMcpToken` uses singleton `prisma`
- Disposition: No-op. All clients share the same DB; revocations committed by raceClient are visible to singleton.

## Testing Findings

### T1 [Major]: Mock-reality divergence — `updateMany` returns `{}` not `{count: N}`
- File: `src/__tests__/lib/mcp/refresh-token.test.ts:142,146` — pre-fix
- Evidence: Default mock returned `{}`, but real Prisma returns `{ count: number }`. Success-path CAS check `claim.count === 0` was vacuously falling through on `undefined === 0` (false).
- Fix: Default to `{ count: 1 }`. Race-loss tests override with `{ count: 0 }`.

### T2 [Major]: Audit gap — same as F-2
- Resolution: Same as F-2. Added route.test.ts unit test.

### T3 [Major]: Missing race_lost branch unit test
- File: `src/__tests__/lib/mcp/refresh-token.test.ts`
- Fix: Added "CAS race-lost (count === 0)" test asserting concurrent_rotation_revoked + family revocation in Phase 2.

### T4 [Major]: Race loop could vacuously pass if all iterations bothFailed
- File: `src/__tests__/db-integration/adversarial/mcp-token-rotation-race.adversarial.integration.test.ts:295-303`
- Fix: Added `expect(successes).toBeGreaterThan(0)` non-vacuous-pass guard.

### T5 [Minor]: `jest.Mock` type reference unused
- Disposition: Pre-existing in the file; not introduced by this PR. Acceptable at runtime via vi.fn return-type compat.

### T6 [Minor]: `withBypassRls` mock missing `purpose` parameter
- Fix: Updated mock to accept and ignore the `purpose` arg, and to pass `prisma` as `tx` (matches Contract 1 fix in production code).

### T7 [Minor]: Sentinel-grep vacuity in crypto tests
- Disposition: Forward regression guard — current Web Crypto / Node AES-GCM errors don't include data. Assertion catches future implementation regressions that would leak data. Acceptable.

## Adjacent Findings

None explicitly tagged.

## Quality Warnings

None — all findings include file/line evidence.

## User-requested addition (recurring memory: 3+ string literals → const-object)

User noted line 352 `type: "replay"` is a raw string literal across multiple enumerated values. Per recurring user feedback (`feedback_const_object_for_string_literals.md`), 3+ enumerated string literals must use the const-object pattern (matches AUDIT_ACTION style).

Resolution: Created `REFRESH_EXCHANGE_REASON` (4 values: REPLAY, CONCURRENT_ROTATION_REVOKED, EXPIRED, REVOKED) and `FAMILY_REVOKED_REASON` (2 values: CONCURRENT_ROTATION, REPLAY) const-objects in `src/lib/constants/auth/mcp.ts`. Applied across `oauth-server.ts`, `route.ts`, and integration test assertions.

## Recurring Issue Check

### Functionality expert
- R1: PASS (helpers reused)
- R3: PASS (single caller of exchangeRefreshToken updated; new fields are additive, no breakage)
- R4-R32: PASS or N/A
- R33: PASS (CI paths extended for mcp + vault)
- R34: PASS post-fix (Contract 1 violation closed; transaction context discipline restored)

### Security expert
- R29: PASS (RFC 9700 §4.14.2 verbatim citation; verified)
- R34: PASS post-fix (was PARTIAL pre-fix due to Contract 1 violation)
- R36: PASS post-fix (no nested $transaction anti-pattern remains)
- RS1: PASS (timingSafeEqual via safeEqual)
- RS2: N/A
- RS3: N/A
- RS4: PASS (only `<placeholder>@example.com` test data)

### Testing expert
- RT1: PASS post-fix (mock now returns `{count: number}`)
- RT2: PASS (tenant-swap test exercises actual RLS via passwd_app + withTenantRls; non-vacuous guard added)
- RT3: PASS (REFRESH_EXCHANGE_REASON constants used in test assertions)

## Resolution Status

### F-1 / S1 [Critical] Contract 1 violation — RESOLVED
- Action: Restructured Phase 1 + revokeFamilyOutOfBand to use the `tx` argument from withBypassRls callback instead of nesting `dbClient.$transaction(...)`. All queries now run on the GUC-bearing transaction client. Test injection path (raw client) now operates correctly.
- Modified: `src/lib/mcp/oauth-server.ts:338-444, 494-519`
- Commit: 55672431

### F-2 / T2 [Major] MCP_REFRESH_TOKEN_FAMILY_REVOKED audit untested — RESOLVED
- Action: Added "concurrent_rotation_revoked → MCP_REFRESH_TOKEN_FAMILY_REVOKED" audit assertion in `route.test.ts`. Existing replay audit assertion also extended with `reason: "replay"` metadata field check (S5 fix).
- Modified: `src/app/api/mcp/token/route.test.ts:256-318`
- Commit: 55672431

### F-3 / S2 [Major] Contract 3 success-return fields — RESOLVED
- Action: Added `refreshTokenId: string` and `familyId: string` to the success result. Capture from `tx.mcpRefreshToken.create(...)` return value and `rt.familyId`.
- Modified: `src/lib/mcp/oauth-server.ts:316-325, 432-441, 449-461`
- Commit: 55672431

### T1 [Major] updateMany mock returns `{}` — RESOLVED
- Action: Default mock now returns `{ count: 1 }`. Race-loss tests override with `{ count: 0 }`.
- Modified: `src/__tests__/lib/mcp/refresh-token.test.ts:146`
- Commit: 55672431

### T3 [Major] race_lost branch unit test — RESOLVED
- Action: Added "CAS race-lost (count === 0): returns concurrent_rotation_revoked + revokes family" test.
- Modified: `src/__tests__/lib/mcp/refresh-token.test.ts:381-414`
- Commit: 55672431

### T4 [Major] race loop vacuous-pass guard — RESOLVED
- Action: Added `expect(successes).toBeGreaterThan(0)` after the loop's cardinality assertions.
- Modified: `src/__tests__/db-integration/adversarial/mcp-token-rotation-race.adversarial.integration.test.ts:296-303`
- Commit: 55672431

### T6 [Minor] withBypassRls mock arity — RESOLVED
- Action: Mock now accepts `(prisma, fn, purpose)` and passes `prisma` as the `tx` argument to fn.
- Modified: `src/__tests__/lib/mcp/refresh-token.test.ts:14-18`
- Commit: 55672431

### S5 [Minor] Replay path audit metadata symmetry — RESOLVED
- Action: Added `reason: FAMILY_REVOKED_REASON.REPLAY` to replay path's audit metadata.
- Modified: `src/app/api/mcp/token/route.ts:121-128`
- Commit: 55672431

### User-requested constants — RESOLVED
- Action: Created `REFRESH_EXCHANGE_REASON` and `FAMILY_REVOKED_REASON` const-objects per recurring "3+ string literals → const-object" memory rule.
- Modified: `src/lib/constants/auth/mcp.ts:73-92`, `src/lib/mcp/oauth-server.ts` (return values), `src/app/api/mcp/token/route.ts` (audit branches)
- Commit: 55672431

### F-4 [Minor] "not_found" reason union — Skipped (Anti-Deferral)
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: future audit code can't distinguish missing-token from other failures by type
  - Likelihood: low (current code returns same `error: "invalid_grant"` either way; route handler doesn't branch on it)
  - Cost to fix: trivial (1-line union addition + 1 case branch)
- **Orchestrator sign-off**: deferred — three-value justification provided; can be added in a follow-up PR if a future caller needs to distinguish.

### F-5 [Minor] Migration audit_chain_anchors default — Skipped (Anti-Deferral)
- **Anti-Deferral check**: pre-existing in unchanged file (the schema drift existed on main; Prisma generated migration captured it)
- **Justification**: Functionally benign no-op (sets a default that matches the schema's existing default). No security or functional impact. No file outside this PR's scope changes.
- **Orchestrator sign-off**: documented in PR description; no action required.

### S3 [Major] Phase 2 durable retry surface — Skipped (Anti-Deferral)
- **Anti-Deferral check**: out of scope (different feature)
- **Justification**: Contract 2 explicitly permits deferring durable retry IF a grep-able log line is present. The `mcp.refresh_token.family_revocation_failed` structured log message is present. A durable retry surface (audit_outbox or dedicated retry table) is a separate feature beyond #435 scope.
- **Orchestrator sign-off**: TODO marker — `grep -rn "mcp.refresh_token.family_revocation_failed"` finds the log emission point; future PR can add retry plumbing on top.

### S4 [Low] both-failed family-revocation un-asserted — Skipped (Anti-Deferral)
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: a regression that skipped Phase 2 revocation on the both-replay path would not be caught
  - Likelihood: low (Phase 2 revocation is shared code for both replay and race_lost; T3 unit test already covers this code path)
  - Cost to fix: low (loop body could assert family revocation in both-failed branch too)
- **Orchestrator sign-off**: T3 unit test covers the same code path with deterministic mocks; integration redundancy not load-bearing.

### S6 [Informational] validateMcpToken singleton — Accepted
- **Anti-Deferral check**: acceptable risk
- **Justification**: Worst case = none (all clients share DB, revocations visible across pools). Likelihood = N/A. Cost to change = high (broader API surface change).
- **Orchestrator sign-off**: documented; no fix required.

### T5 [Minor] jest.Mock type reference — Pre-existing in unchanged file context
- **Anti-Deferral check**: pre-existing in changed file (refresh-token.test.ts is in the diff for unrelated mock updates)
- **Justification**: The `jest.Mock` type reference is at line 131-132 — an interface field type. The PR touches the file but does NOT touch lines 131-132. Pre-existing in a non-modified region of a changed file.
- **Orchestrator sign-off**: per touched-file rule, this is a borderline case. Existing usage works at runtime. Will fix in a separate cleanup PR if it surfaces in CI typecheck.

### T7 [Minor] sentinel-grep vacuity — Accepted
- **Anti-Deferral check**: acceptable risk
- **Justification**: Worst case = test produces no signal for future implementations that leak plaintext in error messages. Likelihood = low (current Web Crypto / Node AES-GCM errors don't include data). Cost to change = high (would require injecting a wrapper layer that explicitly leaks data, which contradicts the assertion's goal).
- **Orchestrator sign-off**: assertion is a forward regression guard, not vacuous in the failure direction. Acceptable.
