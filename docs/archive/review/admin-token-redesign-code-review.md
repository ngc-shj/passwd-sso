# Code Review: admin-token-redesign

Date: 2026-04-27

## Round 2 — Convergence

All Round 1 findings verified resolved. One informational finding (N1: CREATE
audit test missing `tokenSubjectUserId` assertion) was fixed in the same
review cycle.

**Convergence assessment**: plan converged after Round 1 fix pass + Round 2
verification.

## Round 1

### Functionality (5 findings)

#### F1 [Major] Four mandatory unit route test files missing
- Files: `src/app/api/maintenance/{dcr-cleanup, audit-outbox-metrics, audit-outbox-purge-failed, audit-chain-verify}/route.test.ts` — none existed.
- Impact: auth-gate, audit-emit shape, demoted-subject 400 not unit-tested for 4 of 7 routes.
- Resolution: 4 new test files created; 34 tests added; all pass.
  - `dcr-cleanup`: 8 tests
  - `audit-outbox-metrics`: 7 tests
  - `audit-outbox-purge-failed`: 11 tests
  - `audit-chain-verify`: 8 tests

#### F2 [Minor] Stale manual test script (`run-pr-379-test-plan.sh`) contradicts new implementation
- Resolution: script updated — no `operatorId` body/query, asserts `actorType=HUMAN` + `tokenSubjectUserId` + `tokenId`.

#### F3 [Minor] `OPERATOR_TOKEN_NOT_FOUND` error code dead-coded
- Resolution: `[id]/route.ts` now uses `errorResponse(API_ERROR.OPERATOR_TOKEN_NOT_FOUND, 404)` instead of bare `notFound()`.

#### F4 [Minor] Revoke route comment falsely claims idempotent behavior
- Resolution: comment updated to "Returns 409 if already revoked".

#### F5 [Minor] `authPath` field absent from audit emission with no documentation
- Resolution: `docs/operations/admin-tokens.md` notes that `authPath` is not emitted in v1 (the parallel-acceptance design that needed it was dropped pre-merge).

### Security (3 findings)

#### S1 [Minor] Scope field parsed but never enforced in maintenance routes
- Forward-regression risk: when a second scope is added, narrower-scope tokens silently get full maintenance access unless route handlers add explicit scope checks.
- Resolution: `AdminAuth.scopes` field carries an inline warning comment in `src/lib/auth/tokens/admin-token.ts` requiring future scope additions to add per-route gates.

#### S2 [Minor] Audit CREATE/REVOKE metadata omits `tokenSubjectUserId`; inconsistent with the 7 maintenance routes
- Resolution: both `route.ts` (CREATE) and `[id]/route.ts` (REVOKE) now emit `metadata.tokenSubjectUserId`. SIEM correlation across CREATE/USE/REVOKE works uniformly.

#### S3 [Minor] `audit-chain-verify` accepts a token bound to tenant A to operate on tenant B
- Token-as-capability boundary violation. Operator-tokens are tenant-scoped; multi-tenant operators must mint per-tenant tokens.
- Resolution: route enforces `auth.tenantId === query.tenantId`; returns 403 on mismatch.

### Testing (3 findings)

#### T1 [Minor] Token prefix constant not imported in 3 route test files
- Resolution: 3 rewritten route tests now import `OPERATOR_TOKEN_PREFIX` from `@/lib/constants/auth/operator-token` and use `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}` instead of the inlined `"op_"` literal.

#### T2 [Minor] `withBypassRls` mock arity mismatch
- Resolution: 3 mock declarations updated to match the real 3-arg signature `(_prisma, fn, _purpose?) => fn()`.

#### T3 [Minor] `rotate-master-key/route.test.ts` imports unused `afterEach`
- Resolution: import removed.

## Round 2 — Verification

All 11 Round 1 findings verified resolved. One new informational finding:

#### N1 [Info] CREATE audit test missing `tokenSubjectUserId` assertion
- Test coverage gap: route emits the field correctly (S2 fix) but the CREATE test only asserts `tokenId` + `scope`.
- Resolution: `route.test.ts:343` now also asserts `tokenSubjectUserId: USER_ID` in the CREATE audit metadata. Test passes.

## Quality Warnings

No findings flagged `[VAGUE]`, `[NO-EVIDENCE]`, or `[UNTESTED-CLAIM]`.

## Recurring Issue Check (final state)

### Functionality
- R1 (helper reuse): OK
- R2 (constants): OK (T1 corrected the 3 route tests)
- R3 (propagation): OK
- R4 (event dispatch): OK
- R5 (transactions): OK
- R6 (cascade orphans): OK
- R7-R8 (E2E/UI): UI deferred to follow-up PR
- R9 (fire-and-forget tx): OK
- R10 (circular imports): OK
- R11 (display vs subscription): OK
- R12 (enum coverage): OK
- R13 (re-entrant dispatch): OK
- R14 (DB role grants): OK
- R15 (env in migration): OK
- R16 (dev/CI parity): OK
- R17 (helper adoption): OK
- R18 (allowlist sync): OK
- R19 (test mock alignment + exact-shape): OK
- R20 (mechanical edits): N/A
- R21 (sub-agent verification): OK (sub-agent test output independently verified)
- R22 (perspective inversion): OK
- R23-R28 (UI): N/A
- R29 (external spec citations): OK (none cited)
- R30 (Markdown autolinks): N/A

### Security
- RS1 (timing-safe): OK (SHA-256 hash lookup over 256-bit preimage)
- RS2 (rate limit on new routes): OK (CRUD + 7 admin routes)
- RS3 (input validation): OK (Zod `.strict()` on CRUD)

### Testing
- RT1 (mock-reality divergence): OK (validator mock shape matches real return)
- RT2 (testability): OK (every test case implementable with current mocks)
- RT3 (shared constants in tests): OK (T1 corrected)

## Resolution Status

All 12 findings (1 Major + 11 Minor + 1 informational R2) resolved. Pre-PR
suite passes all 11 checks. Plan converged.
