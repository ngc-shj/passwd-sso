# Plan Review: centralize-state-transitions

Date: 2026-05-04
Review rounds: 1, 2

## Round 2 — Summary

All 37 Round 1 findings (across F/S/T) resolved by contract-first rewrite. Round 2 surfaced 15 NEW findings (3 Critical, 7 Major, 5 Minor); all addressed in plan as of 2026-05-04.

### Round 2 — New findings & resolutions

| ID | Severity | Finding | Plan response |
|----|----------|---------|---------------|
| F14 | Critical | bulkTransition replacement of `markGrantsStaleForOwner` drops `keyVersion: null` arm — leaks pre-keyVersion grants past rotation (#433/S1 regression) | Step 5 specifies `where: { ownerId, OR: [{ keyVersion: { lt: newKeyVersion } }, { keyVersion: null }] }` |
| F15 | Critical | bulkTransition omits `ownerEphemeralPublicKey: null` extraData clear — defeats #433/S2 minimum-clear defense | Step 5 specifies `extraData: { ownerEphemeralPublicKey: null }` |
| T17 | Critical | Vault auto-promote race test specified at HTTP layer but integration suite has no HTTP harness | Step 3 special case extracts `src/lib/emergency-access/vault-auto-promote.ts` lib function; race test runs at lib level via existing `raceTwoClients` helper |
| F16 | Major | Helper internals snippet had dead `MATRIX[args.to].filter(...)` line — type-incorrect | Helper internals snippet rewritten; only `allowedFroms` derivation retained + bypass-scope assertion |
| F17 | Major | access-request `[id]/approve` migration must `throw` on `{ ok: false }` to abort tx (otherwise SA token over-issuance) | Step 4 explicitly mandates throw + outer try/catch maps to existing 409 |
| S12 | Major | Helper accepts arbitrary `Prisma.WhereInput` — future caller could pass `where: { id }` alone, bypassing scope under bypassRls | Helper internals adds `if (isBypassRlsActive() && !hasResourceScope(args.where)) throw ...` |
| S13 | Major | bulkTransition same issue (no tenantId or scope assertion) | Same fix; `hasResourceScope` applies |
| S14 | Major | CI allowlist regex robustness undefined — typo bypass risk | Plan's "CI guard" replaces regex with **AST-based check** via `ts-morph`; self-tested with known-good/bad fixtures |
| T14 | Major | Pre-migration baseline test workflow contradicts single-PR scope | Tests § renames "Pre-migration baseline" — captures shape via `PRE_MIGRATION_AUDIT_SHAPES` fixture transcribed from base-commit source |
| T15 | Major | Property test became tautology (MATRIX vs MATRIX) | Tests § adds `EXPECTED_TRANSITIONS` fixture transcribed from plan's matrix-table; helper asserted against fixture, not its own source |
| T16 | Major | bulkTransition atomicity test no specified failure-injection mechanism | Tests § specifies `__testHook?: (tx) => Promise<void>` parameter on vault-reset.ts (NODE_ENV-gated) |
| S15 | Minor | F5 refetch ordering / error code unspecified | Step 3 special case spells out: `revokedAt: null` check FIRST → `GRANT_REVOKED 403` (NEW error code); then crypto-presence check → existing `KEY_ESCROW_NOT_COMPLETED 400` |
| F18 | Minor | `[id]/request` migration omits `withBypassRls` wrapper preservation note | Step 3 prefix mandates "All call sites stay inside their existing wrapper — do NOT remove" |
| F19 | Minor | `STALE_ELIGIBLE_STATUSES` becomes dead code post-migration | "Derived consts" section: export deleted; invariant lives in test code only |
| T18 | Minor | bulkTransition bulk-site test coverage absent | Tests § adds Integration tests #7 (mixed-status seed), #8 (keyVersion: null guard) |
| T19 | Minor | `allFromTos` undefined in unit-test snippet | Tests § snippet adds explicit `const allFromTos = ALL_STATUSES.flatMap(...)` line |

## Round 1 — Summary

Plan was originally drafted with `tenantId: string` mandatory predicate + `reason`-discriminated failure result + tightened actor matrix derived from route names. All three turned out to be wrong against the actual codebase:

- emergency-access uses `withBypassRls` (cross-tenant break-glass) with per-resource scope (`ownerId` / `granteeEmail` / `granteeId` / `tokenHash`) — NOT `tenantId`
- existing routes return distinct error codes (400 INVALID_STATUS / 400 GRANT_NOT_PENDING / 410 INVITATION_ALREADY_USED) for `count == 0` — uniform 409 mapping breaks them
- `[id]/confirm/route.ts:33` enforces `ownerId === session.user.id` — actor is OWNER, NOT GRANTEE
- PR #433/S1 invariant requires `REQUESTED → STALE (SYSTEM)` matrix row — was missing

Round 1 → Round 2 fix: rewrite plan in **contract-first** style. Helper accepts `where: Prisma.WhereInput` verbatim; returns `{ ok: true } | { ok: false }` only; matrix re-derived from route authorization code. Eliminated tenantId argument, reason discrimination, failure-path findUnique, and the bulk-helper transaction-form change confusion.

## Changes from Previous Round

Round 1 → Round 2: contract-first rewrite (see above).

## Functionality Findings

### F1 [Critical]: Matrix actor for `[id]/confirm` is wrong — claims GRANTEE, route enforces OWNER
- File / plan section: "Emergency-access transition matrix" rows ACCEPTED→IDLE & STALE→IDLE
- Evidence: `src/app/api/emergency-access/[id]/confirm/route.ts:33` — `if (!grant || grant.ownerId !== session.user.id) return notFound()`. Only OWNER can call this route (owner escrows the wrapped secretKey).
- Impact: Production-breaking. Migration would set actor=GRANTEE, helper would reject OWNER-driven calls, breaking key escrow + post-rotation re-confirm.
- Fix: Re-derive matrix actors from each route's authorization code, not from route file names.

### F2 [Critical]: Matrix omits `REQUESTED → STALE` row, regressing PR #433/S1
- File / plan section: EA matrix; Implementation step 2a (derived `STALE_ELIGIBLE_STATUSES`)
- Evidence: `src/lib/emergency-access/emergency-access-state.ts:52-56` legacy const = `[IDLE, REQUESTED, ACTIVATED]` with explicit security-comment citing PR #433/S1. Plan matrix has only `IDLE→STALE` and `ACTIVATED→STALE` (SYSTEM); REQUESTED is missing.
- Impact: Cryptographic key compromise — grantee whose REQUESTED grant straddles a key rotation can decrypt owner's pre-rotation secretKey via stale escrow material.
- Fix: Add `REQUESTED → STALE (SYSTEM)` row to matrix BEFORE deriving the const.

### F3 [Critical]: Helper-result `invalid_transition → 409` mapping breaks existing 400/410 contracts (violates F-R5)
- File / plan section: "Failure-result discrimination" block; F-R5 (no behavioral change)
- Evidence: existing routes return `INVITATION_ALREADY_USED 410` (accept, reject), `GRANT_NOT_PENDING 400` ([id]/accept, [id]/decline), `INVALID_STATUS 400` (others). Plan maps everything to 409.
- Impact: Test suite breaks; iOS/extension clients branching on status code break; UI error messaging breaks.
- Fix: Helper returns only `{ ok: true } | { ok: false }`. Routes keep their existing failure-path error code mapping.

### F4 [Major]: Mandatory `tenantId: string` argument breaks 6 cross-tenant routes that use `withBypassRls`
- File / plan section: Module shape; Risk #11
- Evidence: 6 emergency-access routes (accept, reject, [id]/accept, [id]/decline, [id]/request, [id]/vault) intentionally use `withBypassRls` for cross-tenant break-glass; their CAS predicate uses `ownerId`/`granteeEmail`/`granteeId`/`tokenHash`, NOT `tenantId`.
- Impact: Forcing `tenantId` either (a) breaks these routes (count===0 always) or (b) drops the existing per-resource scope (security regression).
- Fix: Helper accepts arbitrary `where: Prisma.WhereInput`; routes pass their existing scope predicate verbatim.

### F5 [Major]: `[id]/vault` auto-promote vs revoke race — incomplete bug fix
- File / plan section: Implementation step 2 special case
- Evidence: revoke clears crypto material (`encryptedSecretKey`, `secretKeyIv`, etc.); auto-promote sets only `status` + `activatedAt`. Local `grant` variable holds pre-revoke crypto fields → response can return wrapped secretKey AFTER revoke commits.
- Impact: Real-time TOCTOU — revoked grant's wrapped secretKey can be returned mid-request.
- Fix: After `transition({ to: ACTIVATED }) === ok`, RE-FETCH grant (under `withBypassRls`) and re-validate `revokedAt: null` before serializing crypto fields.

### F6 [Major]: `withUserTenantRls(uid, async () => ...)` no-arg overload — `tenantId` not in scope
- File / plan section: "withTenantRls interaction"
- Evidence: 3 OWNER routes (approve, confirm, revoke) use `withUserTenantRls(uid, async () => ...)` (no-arg overload).
- Impact: With the F4 fix (arbitrary WhereInput), this is no longer an issue. If F4 is not adopted, refactoring to threaded-tenantId is required.
- Fix: Adopt F4 fix.

### F7 [Major]: Actor-coverage matrix test only asserts "every actor used somewhere" — too weak for R12
- File / plan section: Risk #8
- Fix: Strengthen test: TypeScript exhaustive `Record<Actor, Record<Status, Record<Status, boolean>>>`. Adding either a status OR an actor forces compile-time updates.

### F8 [Major]: `[id]/revoke` returns-to-IDLE branch tightens existing allowed-from set
- File / plan section: Matrix `REQUESTED → IDLE`
- Evidence: `[id]/revoke/route.ts:99` second updateMany uses `fromStatusesFor(IDLE)` = `[ACCEPTED, STALE, REQUESTED]` today; OWNER is the actor.
- Impact: Plan's `REQUESTED → IDLE (OWNER)` only — drops ACCEPTED→IDLE and STALE→IDLE for OWNER. Behavioral tightening.
- Fix: Either (a) widen matrix to include `ACCEPTED→IDLE OWNER` and `STALE→IDLE OWNER`, OR (b) explicitly document the tightening as a deliberate behavior change. Recommend (a) — preserves F-R5.

### F9 [Major]: `bulkTransition` and single-row `transition` have inconsistent `tenantId` requirements
- Fix: With F4 fix, both helpers accept WhereInput; asymmetry resolved.

### F10 [Minor]: `REQUESTED → REVOKED` matrix entry marked "deferred" — actually reachable today via `permanent: true`
- File / plan section: Matrix line; revoke route `permanent` flag
- Fix: Remove "deferred" comment; mark as reachable.

### F11 [Minor]: `[id]/revoke` is dual-mode (permanent + non-permanent) — needs 2 `transition()` calls
- Fix: Step 2 explicitly says "[id]/revoke = 2 transition() calls; thread `requestedAt: null, waitExpiresAt: null` via extraData on the IDLE branch".

### F12 [Minor]: Legacy 2-arg `canTransition` / `fromStatusesFor` have zero callers post-migration
- Fix: Remove in this PR; deprecation window unnecessary. (Re-confirm via grep.)

### F13 [Minor]: Risks #2 "require tx parameter" contradicts NF-R1 `db: TxOrPrisma`
- Fix: Reconcile — keep `db: TxOrPrisma`, remove the "require tx" claim.

## Security Findings

### S1 [Critical]: `tenantId` predicate incompatible with cross-tenant break-glass model
- Same root cause as F4. Helper signature must support per-resource scope (`ownerId`, `granteeEmail`, `granteeId`, `tokenHash`, `tenantId`).
- escalate: true
- escalate_reason: multi-step trust boundary across cross-tenant break-glass + RLS-bypass paths; misimplementation either locks users out of recovery or drops the only authorization predicate.

### S2 [Major]: `[id]/vault` migration runs under `withBypassRls` — `tenantId` predicate provides no defense-in-depth there
- File / plan section: Implementation step 2 special case; RLS interaction
- Evidence: `[id]/vault/route.ts:31-39` uses `withBypassRls`, RLS is OFF. Authorization predicate is the in-route `granteeId !== session.user.id` check, not a DB predicate.
- Fix: Document that `[id]/vault` defense is the route-level `granteeId` check + the new helper's `where: { granteeId: session.user.id }` scope. CAS predicate's role here is ONLY race-closing, not cross-tenant defense.

### S3 [Major]: Audit emit ordering for `[id]/vault` auto-promote unspecified — phantom audit row possible
- File / plan section: Implementation step 2 special case; Risk #9
- Fix: Step 2 must specify: "emit `EMERGENCY_ACCESS_ACTIVATE` audit ONLY when `transition()` returns `{ ok: true }`. On `{ ok: false }`, refetch grant, do NOT emit audit (the concurrent winner emits)."

### S4 [Major]: `bulkTransition()` cannot be inserted into `vault-reset.ts`'s `prisma.$transaction([...])` array form
- File / plan section: Implementation step 2a; `src/lib/vault/vault-reset.ts:42-103`
- Evidence: existing transaction is array form (PrismaPromise objects). New `bulkTransition` is `async`, returns `Promise<{ updated: number }>` — incompatible with array.
- Impact: Implementer literal-following the plan creates non-atomic vault-reset (data deletion commits while EA grants stay non-REVOKED on failure). Re-opens the cross-rotation atomicity invariant from PR #433.
- Fix: Step 2a must explicitly call out the change to `prisma.$transaction(async (tx) => { ... await bulkTransition({ db: tx, ... }); ... })` callback form. Add integration regression test for vault-reset atomicity.

### S5 [Major]: CI grep guard exclusions too broad (state.ts, server.ts, vault-reset.ts) — silenced regression
- Fix: Switch to allowlist: `scripts/state-mutation-allowlist.txt` containing `src/lib/emergency-access/emergency-access-state.ts` + `src/lib/access-request/access-request-state.ts`. CI fails if any other file mutates `data: { status: ... }` on these tables. Wire into `ci.yml` (lint stage), NOT `ci-integration.yml` (path-scoped).

### S6 [Minor]: Timing-side-channel via failure-discrimination `findUnique`
- Fix: Resolved by F3/T1 fix — helper does NOT call `findUnique`, so no timing distinction between `not_found` and `invalid_transition`. Cross-tenant existence oracle vector closed.

### S7 [Minor]: `EXPIRED` registered in matrix without `expiresAt` precondition on `PENDING → APPROVED`
- Fix: Add matrix footnote citing pre-existing latent issue; file follow-up issue NOW for `expiresAt > now()` predicate. (Not in scope per Issue's "Out of scope".)

### S8 [Minor]: `prisma.ts` AsyncLocalStorage proxy invariant undocumented
- Fix: Plan's "Critical design decision" block adds a paragraph: "depends on `src/lib/prisma.ts:145-174` Proxy that re-targets calls to active `withTenantRls` tx via AsyncLocalStorage". Add JSDoc warning at the proxy export.

### S9 [Minor]: `withTenantRls` wrap verification by manual checklist is not a control
- Fix: Add runtime assertion in `transition()`: `if (getTenantRlsContext() === undefined && process.env.NODE_ENV !== "test") throw Error("transition: must be called inside withTenantRls / withBypassRls / withUserTenantRls scope")`. Bypass ctx is acceptable.

### S10 [Critical-impact, Minor-flagged]: `STALE_ELIGIBLE_STATUSES` derivation regresses PR #433/S1
- Same as F2/T3. Critical-impact, classified Minor only because the proposed invariant test would catch it (but the test would fail at lint stage).

### S11 [Minor]: `reason` field crosses trust boundary if surfaced to MCP/SA tokens
- Fix: Resolved by F3 fix — helper has no `reason` field. (Type-level seal not needed.)

## Testing Findings

### T1 [Critical]: Failure-path test mocks need `findUnique` on tx object, NOT global mock — different structural change
- File / plan section: Implementation step 6; "Failure-path tests"
- Evidence: tx-scoped routes (accept, [id]/accept, access-requests/[id]/approve) mock via `mockTransaction.mockImplementation(...)` returning `{ emergencyAccessGrant: { updateMany: mockTxGrantUpdateMany } }` — NO `findUnique` on the tx mock object.
- Impact: Plan's "ONE additional mock" claim under-counts. Implementer adds findUnique to wrong (global) mock; failure tests crash with TypeError.
- Fix: Resolved by F3 fix — helper makes no findUnique call, so no mock change needed. Test suite passes unchanged for both success- and failure-paths.

### T2 [Critical]: Helper API doesn't match emergency-access ownerId-scoped CAS
- Same root cause as F4/S1.
- Fix: Helper accepts `where: Prisma.WhereInput`.

### T3 [Critical]: Matrix-derived `STALE_ELIGIBLE_STATUSES` drops REQUESTED — invariant test fails on day 1
- Same as F2/S10.
- Fix: Add `REQUESTED → STALE (SYSTEM)` to matrix.

### T4 [Major]: `count: 0` test sites not enumerated in plan — counted-impact step is process not deliverable
- Fix: With F3/T1 fix, no longer applicable (no test changes needed). Plan acknowledges in "Backward compatibility" section.

### T5 [Major]: Audit-event preservation has no automated test
- Fix: Add `step 4.5: pre-migration baseline tests` — for each migrated route, add `expect(logAuditAsync).toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTION.<X>, metadata: <X> }))`. Commit baselines BEFORE migration; same assertions remain after migration → proves no shape drift.

### T6 [Major]: Concurrency test fresh-DB pattern unspecified
- Fix: Plan specifies test pattern: `for (let i = 0; i < 100; i++) { create row → race two transition() → assert exactly one ok → delete row }`. Reference precedent in `src/__tests__/db-integration/` if exists; otherwise justify the pattern.

### T7 [Major]: Reason-leak end-to-end test described in prose, not codified
- Fix: Resolved by F3/S11 fix — no `reason` field exposed. Codified test no longer needed.

### T8 [Major]: CI guard wiring ambiguous (ci.yml vs ci-integration.yml)
- Fix: Plan specifies: "guard runs in `ci.yml` (always-on lint job), NOT in path-scoped `ci-integration.yml`". Verify via `gh api repos/<owner>/<repo>/branches/main/protection` that the new check is in required-checks list.

### T9 [Major]: Vault-route CAS test path filter excludes test target
- File / plan section: Implementation step 2 special case
- Evidence: `ci-integration.yml` paths filter does not include `src/app/api/emergency-access/[id]/vault/**`.
- Fix: Plan adds CI infra change: extend `ci-integration.yml` paths to include the route directory + `src/lib/emergency-access/**`. Document in plan as a blocking dependency.

### T10 [Major]: Backward-compat property test unspecified — two contradictory descriptions
- Fix: Plan spells out both property tests verbatim:
  ```ts
  test.each(allFromTos)("legacy canTransition === ∃actor canTransitionAs", (from, to) => {
    expect(canTransition(from, to)).toBe(EA_ACTORS.some(a => canTransitionAs(from, to, a)));
  });
  ```
  Same for `fromStatusesFor`. Use shared `EA_ACTORS` constant (RT3).

### T11 [Minor]: Matrix iteration source — Prisma enum vs `EA_STATUS` constant drift
- Fix: Iterate `Object.values(EmergencyAccessStatus)` from `@prisma/client` (the schema source of truth). Add invariant test: `expect(Object.values(EA_STATUS).sort()).toEqual(Object.values(EmergencyAccessStatus).sort())`.

### T12 [Minor]: `EXPIRED` matrix row has no caller verification
- Fix: TODO marker grep-able; add a unit test asserting the helper accepts the transition (so a future cron implementation works without re-touching the matrix).

### T13 [Minor]: Test-helper boilerplate amplification
- Fix: Resolved by F3/T1 fix (no per-test mock changes needed).

## Adjacent Findings

(None — all findings stayed within their expert's scope.)

## Quality Warnings

(None flagged by merge gate.)

## Recurring Issue Check

### Functionality expert
- R1 (shared utility reuse): applicable + addressed (TxOrPrisma reused)
- R2 (constants): applicable + addressed (EA_STATUS, AUDIT_ACTION)
- R3 (mutation site enumeration): applicable + addressed (18 hits classified)
- R4 (config drift): not applicable
- R5 (real-DB vs mock): applicable + addressed (integration suite)
- R6 (auth path coverage): applicable + gap — F4/F5
- R7 (rate-limit preservation): applicable + addressed
- R8 (audit log preservation): applicable + addressed
- R9 (fire-and-forget tx boundary): applicable + addressed (NF-R2)
- R10 (circular import): applicable + addressed (NF-R3)
- R11 (display ≠ subscription group): not applicable
- R12 (enum/action coverage): applicable + gap — F1, F2, F7
- R13 (DI/boundary): applicable + addressed
- R14: not applicable
- R15: applicable + gap — F3 status-code change implies OpenAPI sync needed
- R16: applicable + addressed
- R17: applicable + addressed
- R18: not applicable
- R19: not applicable
- R20: applicable + addressed (rollback)
- R21: applicable + gap — F4, F6 (cross-tenant routes use withBypassRls)
- R22-R30: not applicable
- R31: applicable + addressed
- R32: not applicable
- R33: applicable + addressed
- R34: applicable + addressed
- R35: applicable + addressed
- R36: applicable + gap — F12 (legacy 2-arg has zero callers; deprecation unnecessary)

### Security expert
- R1: applicable + addressed
- R2-R10: not applicable / addressed (see Security findings)
- R31: applicable + gap — S1, S2, S4 reveal defense-in-depth claims don't match cross-tenant break-glass; (g) audit-destruction in S3
- R32: not applicable
- R33: applicable + gap — S5 (CI guard exclusions too broad)
- R34: applicable + addressed
- R35: applicable + gap — manual-test plan deferred; S6 + S3 add new scenarios
- R36: applicable + gap — S9 (manual checklist is not a control)
- RS1: applicable + addressed (no credential comparison; S6 surfaced timing-side-channel)
- RS2: applicable + addressed
- RS3: applicable + addressed
- RS4: applicable + addressed (no PII)

### Testing expert
- R1: applicable + addressed
- R3: applicable + addressed
- R5: applicable + addressed (concurrency test specified — T6 refines)
- R9: applicable + addressed
- R10: applicable + addressed
- R12: applicable + gap — Object.values source ambiguity (T11)
- R16: applicable + addressed (RLS interaction acknowledged)
- R19: applicable + gap — discriminated result type may break exact-shape matchers (coupled with T1)
- R31: applicable + addressed
- R32: not applicable
- R33: applicable + gap — T8 wiring ambiguity
- R34: applicable + addressed
- R35: applicable + addressed
- R36: not applicable
- RT1: applicable + addressed (count: 1 / count: 0 matches Prisma.BatchPayload)
- RT2: applicable + addressed
- RT3: applicable + gap — T10 (need EA_ACTORS constant), T11 (Prisma enum vs constant)
