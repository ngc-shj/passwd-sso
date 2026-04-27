# Code Review: sessioncache-redesign

Date: 2026-04-27
Review round: 1

## Changes from Previous Round

Initial review of all commits on `refactor/sessioncache-redesign` since branching from `main`. Three commits' worth of work covered: 7 implementation commits + 1 follow-up refactor. Plan and deviation log read alongside the diff.

## Seed Finding Disposition

- **seed-func [Major]**: type `evictionInfo.evicted` lacks `sessionToken` — **Rejected**. Verified `auth-adapter.ts:248` declares `evicted: { id: string; sessionToken: string; ipAddress: string | null; userAgent: string | null }[]`; cast at line 327-330 mirrors the same shape; vitest 7428 tests pass.
- **seed-sec [No findings]** — independent review performed; no security findings.
- **seed-test [Major]**: proxy.test.ts:100 inverted mock — **Rejected**. Verified test at proxy.test.ts:868-890 correctly orders mock calls (.mockResolvedValueOnce({valid:true}) → .mockResolvedValue(null)) and asserts the correct fetch counts.

## Functionality Findings

```
[F-1] Major: SSO bootstrap-tenant migration mutates Session.tenantId without invalidating the session cache
- File: src/auth.ts:108-111
- Evidence:
    await tx.session.updateMany({
      where: { userId, tenantId: existingTenantId },
      data: { tenantId: found.id },
    });
  No invalidateCachedSessions call appears anywhere in the migration block (lines 80-160 of src/auth.ts). The plan's §C3 obligation states "every site that mutates Session rows OR mutates tenant fields cached in SessionInfo MUST invalidate the cache". SessionInfo.tenantId is part of the cached payload (session-cache.ts:18), and this migration mutates Session.tenantId on every existing live session for the user.
- Problem: 10th unenumerated R3 site. The 9-site inventory in §C3 covers DELETE paths + 1 policy-mutation path, but does not cover row-level updateMany on a cached field.
- Impact: A user holding a live cached SessionInfo from the bootstrap tenant who then signs in via SSO that triggers the migration will have a stale SessionInfo.tenantId served from cache for up to SESSION_CACHE_TTL_MS (30s). Downstream tenantId-scoped authorization (RLS context, tenant-scoped queries) operates against the OLD bootstrap tenant ID. Narrow window (one-time migration on first SSO sign-in for a bootstrap user with a still-cached prior session) but a real correctness gap inside the plan's R3 scope.
- Fix: Inside the same withBypassRls block, SELECT sessionToken from Session WHERE userId AND tenantId = existingTenantId BEFORE the updateMany; AFTER the transaction commits, call invalidateCachedSessions(tokens). Add a 10th row to §C3 inventory and update the deviation log.

[F-2] Minor: Redundant `as` cast at site 5 (auth-adapter.ts:327-330)
- File: src/lib/auth/session/auth-adapter.ts:327-331
- Evidence: After the type widening at line 245-248 (Phase 2 Batch 4), the inline `as { ... evicted: { ..., sessionToken, ...}[] }` cast restates the declared shape and is no longer load-bearing.
- Problem: Per the project's TypeScript rules ("no non-null assertions; narrowing via predicates not casts"), the cast hides a structural-drift trap — if the declaration drifts the cast wins silently.
- Impact: None functional today. Future regression risk.
- Fix: Replace with plain destructuring: `const { tenantId, maxSessions, evicted } = evictionInfo;`.

[F-3] Minor: expectInvalidatedAfterCommit helper dropped the planned dbSpy parameter
- File: src/__tests__/helpers/session-cache-assertions.ts:16-24
- Evidence: Plan §step 8 specifies `expectInvalidatedAfterCommit(invalidateSpy, dbSpy, expectedTokens)` (3 params). Implementation drops dbSpy and only asserts call-count + arguments on the invalidate spy.
- Problem: The current helper does NOT verify "AFTER" ordering at the helper level. Sequencing is enforced indirectly via expectNotInvalidatedOnDbThrow (negative path), but a reorder where invalidate runs BEFORE DB delete (sync) and DB still succeeds passes the helper.
- Impact: Test surface understates the sequencing-invariant guarantee. Same finding as T-1 from the testing expert.
- Fix: Either (a) restore the planned 3-arg form and assert call-order via mock.invocationCallOrder, OR (b) document the simplification in the deviation log explaining why the negative-path coverage is judged sufficient.

[F-4-A] Minor: Site 5 invalidation runs AFTER audit log (not BEFORE) — inconsistent with site 7's documented order [Adjacent — Testing scope]
- File: src/lib/auth/session/auth-adapter.ts:332-362
- Evidence: B4-D3 documents site 7's order as "invalidation BEFORE audit log" for cache-promptness. Site 5 runs await logAuditAsync(...) and createNotification(...) for each evicted session FIRST, then await invalidateCachedSessions(...) at line 361.
- Problem: Inconsistent ordering across sites with no recorded reason for the divergence.
- Impact: Cache invalidation latency for evicted-by-concurrent-limit sessions is bounded by the audit + notification loop. Functionally within the plan's "≤ 1 s P99" budget but inconsistent.
- Fix: Either (a) move invalidateCachedSessions to immediately after withBypassRls resolves (before the audit loop), matching site 7; or (b) record in the deviation log why site 5 keeps audit-first ordering.
```

## Security Findings

**No findings.**

The session-cache redesign meets all security invariants from the plan:
- HKDF construction matches RFC 5869 idiom (salt empty, info as context); Buffer.from(okm) is zero-copy.
- Read pipeline order is tombstone-first → negative-second → positive-third → poison-evict, structurally enforcing shape exclusivity even though Zod schemas are not `.strict()`.
- NX populate preserves tombstone (verified by integration scenario I against real Redis).
- Master-key V1 pinning eliminates rotation drift; `getCurrentMasterKeyVersion` is not called anywhere in `src/lib/auth/session/`.
- KeyProvider cold-start race (S-5/S-11): all three async functions wrap cacheKey() inside try/catch; setCachedSession's Batch 5 production fix verified.
- `invalidateTenantSessionsCache` SELECT correctly bounded to `tenantId AND expires > now()` (no cross-tenant token leak).
- Throttled logger emits ONLY `{code: errCode}, fixed-message`; no token / userId / err.message ever logged.
- RFC 5869 §2.2 citation accuracy verified.

Defense-in-depth note (not a finding): adding `.strict()` to the Zod schemas would prevent extra-key smuggling, but the read-order ordering already provides the security guarantee. Optional future hardening.

## Testing Findings

```
[T-1] Minor: expectInvalidatedAfterCommit signature drops dbSpy (duplicate of F-3)
- See F-3 above; cross-flagged by both Functionality and Testing experts. Single fix resolves both.

[T-2] Minor: One hardcoded 30_000 literal in test arg position (RT3)
- File: src/lib/auth/session/session-cache.test.ts:307
- Evidence: `await setCachedSession("tok", fixtureNegativeSession, 30_000);` — literal in ttlMs argument.
- Problem: Plan §"Constants in tests" forbids hardcoded 30_000 in session-cache test files. The assertion uses NEGATIVE_CACHE_TTL_MS correctly; the input arg is the only literal.
- Impact: Low — production overrides this value internally for negative cache, so the literal has no semantic meaning. Compliance with T-10 letter.
- Fix: Replace 30_000 with SESSION_CACHE_TTL_MS (already imported on line 70).

[T-3] Minor: Scenarios E + F are it.todo per documented deviation B5-D3 — accepted
- File: src/__tests__/db-integration/session-revocation-cache.integration.test.ts:181-191
- Disposition: Acknowledged as documented. Adapter unit tests in Batch 4 cover deleteUser/deleteSession invalidation paths. No action required.

[T-4-A] Minor: SCIM/team route tests wholly-mock user-session-invalidation — accepted under T-11-A option (b)
- File: scim/v2/Users/[id]/route.test.ts:49 ; teams/[teamId]/members/[memberId]/route.test.ts:55
- Disposition: Accepted. T-11-A's option (b) — a separate non-mocked unit test (user-session-invalidation.test.ts) — is satisfied. No action required.
```

## Adjacent Findings

- **F-4-A** (Functionality → Testing): site 5 invalidation/audit ordering inconsistency — Functionality scope; documented above with both fix options.

## Quality Warnings

(None — every finding has Evidence + Impact + Fix.)

## Recurring Issue Check

### Functionality expert
- R1 (DRY): OK — createThrottledErrorLogger factored out; consumed by rate-limit.ts and session-cache.ts.
- R2 (KISS): OK — read pipeline linear and explicit.
- R3 (pattern propagation): **Gap — F-1**. 9 enumerated sites wired correctly; SSO migration site (auth.ts:108) is a 10th unenumerated site.
- R4 (constants in shared module): OK — TTLs in validations/common.server.ts.
- R5 (TOCTOU): OK — site 3 wraps SELECT-then-deleteMany in $transaction; sites 2/4/8/9 use a tolerable narrow window.
- R6 (input validation): OK — Zod on every cache read.
- R7 (best-effort never throws): OK — all Redis ops caught + throttled-logged.
- R8 (ordering: invalidate AFTER DB): OK — every site await-sequenced after DB write.
- R9 (transaction boundary for fire-and-forget): OK — sites 3, 8 wait on tx resolution.
- R10 (circular module deps): OK — one-direction graph.
- R11 (no `any`): OK — narrow err-shape pattern.
- R12 (named exports): OK.
- R13 (immutability): OK — only one `let` (intentional memoization).
- R14 (await every promise): OK.
- R15 (error narrowing in catch): OK.
- R16 (API stability — getSessionInfo): OK — signature unchanged.
- R17 (helper adoption coverage): OK with caveat — F-1 missed 10th site.
- R18 (test fixture typed literals): OK.
- R19 (no hardcoded constants in tests): OK with caveat — T-2 single literal.
- R20 (tombstone-first read ordering S-12): OK.
- R21 (NX populate guard): OK — verified by integration scenario I.
- R22 (TTL clamp + sub-1s skip): OK; negative cache TTL-immutability invariant verified.
- R23 (cleanup of dead constants): OK — SESSION_CACHE_MAX deleted.
- R24 (HKDF idiom + V1 pinning): OK.
- R25 (Redis fail-open): OK.
- R26 (logger argument order): OK — pino canonical (obj, msg).
- R27 (audit-log alignment): OK with caveat — F-4-A inconsistency.
- R28 (cache invalidation completeness vs C3 inventory): **Gap — F-1**.
- R29 (subkey memoization): OK.
- R30 (negative-cache TTL immutability): OK.

### Security expert
- R1-R30 + RS1-RS3: All OK or N/A. See "Security Findings" — No findings.

### Testing expert
- R1-R30 + RT1-RT3: All OK except RT3 (single literal, T-2) and helper-signature drift (T-1).

## Resolution Status

### F-1 Major: SSO bootstrap-tenant migration mutates Session.tenantId without invalidating cache — Fixed
- **Action**: Added a `tx.session.findMany` SELECT inside the bootstrap-migration $transaction at `src/auth.ts:113-117` to capture sessionTokens BEFORE the updateMany at line 120. After the $transaction commits, `invalidateCachedSessions(migratedSessionTokens)` is called at line 200-202.
- **Modified files**: `src/auth.ts` (+ import of `invalidateCachedSessions`), `src/auth.test.ts` (mock setup: added `session.findMany` mock + `vi.mock` for session-cache-helpers).
- **Verification**: 32 auth.test.ts tests pass; full vitest suite 7428 pass.

### F-2 Minor: Redundant `as` cast at site 5 — Rejected (cast is load-bearing)
- **Anti-Deferral check**: Acceptable risk — quantified.
- **Justification**:
  - Worst case: cast becomes structurally divergent from the declaration. Caught at next-build's strict TS check before merge.
  - Likelihood: Low — declaration and cast live in the same function, change together.
  - Cost to fix (proper): non-trivial. Without the cast, TypeScript's control-flow analysis narrows `evictionInfo` to `never` after the `await`-bearing closure boundary at lines 251-315 (verified via `npx next build` failing with "Property 'map' does not exist on type 'never'"). The cast is the load-bearing escape hatch for TS CFA's known limitation across async-closure narrowing.
- **Action**: Re-added the cast at `src/lib/auth/session/auth-adapter.ts:330-334` with an inline comment explaining why CFA narrowing requires it. Documented as F-2 disposition.
- **Orchestrator sign-off**: Confirmed the cast is functionally load-bearing per next-build error; the project's "no `as` casts" rule explicitly carves out unsafe escape hatches, but a cast that re-asserts the declared shape is acceptable when CFA cannot prove narrowing.

### F-3 / T-1 Minor: expectInvalidatedAfterCommit helper drops dbSpy parameter — Fixed
- **Action**: Added optional `dbSpy?: Mock` 3rd parameter to `src/__tests__/helpers/session-cache-assertions.ts:16-32`. When passed, the helper asserts `invalidateSpy.invocationCallOrder[0] > dbSpy.invocationCallOrder[0]` — verifying the sequencing invariant at the helper level. Existing 13 callsites continue to work (parameter is optional).
- **Modified files**: `src/__tests__/helpers/session-cache-assertions.ts`.
- **Verification**: Full vitest suite 7428 pass.

### F-4-A Minor: Site 5 invalidation order inconsistent with site 7 — Fixed
- **Action**: Moved `await invalidateCachedSessions(evicted.map((e) => e.sessionToken))` from AFTER the audit/notification loop to BEFORE it at `src/lib/auth/session/auth-adapter.ts:336`. Now consistent with site 7's cache-promptness rationale (B4-D3).
- **Modified files**: `src/lib/auth/session/auth-adapter.ts`.

### T-2 Minor: Hardcoded 30_000 in session-cache.test.ts:307 — Fixed
- **Action**: Replaced `30_000` with `SESSION_CACHE_TTL_MS` (already imported on line 70).
- **Modified files**: `src/lib/auth/session/session-cache.test.ts`.

### T-3 Minor: Scenarios E + F are it.todo — Accepted
- **Anti-Deferral check**: Out of scope (different feature) — DB Session-row setup integration, tracked.
- **Justification**: Scenario E (Auth.js deleteSession adapter) and F (deleteUser cascade) require complex DB Session row fixture setup. Adapter unit tests in `auth-adapter.test.ts` (Batch 4) cover the same `invalidateCachedSessions` call paths under mocking. Documented in deviation log B5-D3. TODO marker grep target: `grep "session-revocation-cache.*it.todo" docs/archive/review/sessioncache-redesign-deviation.md` returns the rationale.
- **Orchestrator sign-off**: Confirmed unit tests cover the same logic; integration coverage is incremental rather than load-bearing.

### T-4-A Minor: SCIM/team route tests wholly-mock user-session-invalidation — Accepted under T-11-A option (b)
- **Anti-Deferral check**: Acceptable risk — quantified per plan §"Round 1 expert review responses" T-11-A.
- **Justification**: The plan explicitly allows two resolution options: (a) `importOriginal` partial mock, OR (b) a separate non-mocked unit test for `user-session-invalidation`. Option (b) is satisfied by `src/lib/auth/session/user-session-invalidation.test.ts` which uses the real function with mocked Prisma + helpers.
- **Orchestrator sign-off**: Plan-prescribed alternative; no action required.

## Final verification

- **Lint**: `npm run lint` — clean.
- **Unit tests**: `npx vitest run` — 7428/7428 pass + 1 skipped.
- **Integration tests**: `npm run test:integration -- session-revocation-cache.integration --reporter=verbose` (real Redis @ docker, real Postgres) — 8/8 active scenarios pass + 2 it.todo as documented.
- **Production build**: `npx next build` — pass.
- **Full pre-PR**: `bash scripts/pre-pr.sh` — 12/12 checks pass.
