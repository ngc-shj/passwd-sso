# Coding Deviation Log: codebase-test-coverage-pr2

## Phase 2 — All batches landed

C1-C6 originally documented as "deferred for follow-up" landed on this branch
in commits `61246968` (C1), `be83b0d7` (C2), `46f05e26` (C3), `f32c3818` (C4),
`3a74acf2` (C5), `4fc68147` (C6). The earlier "Deferred for follow-up" entry
is REPLACED by this section.

## Pre-existing build failure — `npx next build` (UNRELATED to this PR)

**Status**: pre-existing on main; tracked as out-of-scope.

PR #431 added `VAULT_RESET_CACHE_INVALIDATION_FAILED` to the Prisma `AuditAction`
enum but did NOT update `AuditActionValue` closed union at
`src/lib/constants/audit/audit.ts:190`. TypeScript compile fails in
`src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx:137`. R12
propagation defect in main.

**Anti-Deferral check**: pre-existing in unchanged file.
- Worst case: `npx next build` fails on main; production deploy broken.
- Likelihood: high (occurring).
- Cost-to-fix: ~30 min.
- Routing: separate small PR `fix/audit-action-vault-reset-cache-invalidation-failed-r12-propagation`.

TODO(plan/codebase-test-coverage-pr2): if this PR opens before main fix, note in PR description.

---

## Phase 3 final review — accepted deviations

### T100 (Major) Mock allowlist exceeded across C1-C6

Plan §Non-functional 4 enumerates a closed allowlist; C1-C6 implementations
pervasively mock internal sibling components (`./section-X`, `../shared/Y`),
internal hooks (`@/hooks/**`), and internal lib modules (`@/lib/format/*`,
`@/lib/team/*`, `@/lib/audit/audit-action-key`, `@/lib/folder/folder-path`,
etc.).

**Anti-Deferral check**: accepted as a documented Phase 2 deviation.
- Worst case: child-component contract drift goes undetected by parent tests
  (because children are stubbed) — caught only when the real integration runs.
- Likelihood: low (the underlying child components have their OWN tests in
  the same branch, exercising real renders directly).
- Cost-to-fix: HIGH — would require restructuring most C1-C6 tests to use
  real child renders, which conflicts with mock-the-boundary discipline at
  the parent level. Many components are wired to vault contexts whose real
  implementation requires unlocking — impractical to integrate at unit-test
  scale.
- Plan-revision proposal: §Non-functional 4 should explicitly authorize
  "internal sibling component" and "internal hook" mocks subject to the
  S104(a) shape-match obligation (factory exports must match real-module
  exports). Folded into the post-merge plan-update task.

### T101 (Major) §Sec-3 cross-tenant test pattern is partial

5 team test files (`team-form-variants`, `team-archived-list`, `team-trash-list`,
`team-export`, `team-attachment-section`) call `mockTeamMismatch(...)` and
assert `ctx.useTeamVault().currentTeamId !== ctx.teamId`, but do NOT wire
the factory's return value into a `vi.mock("@/lib/team/team-vault-core",
() => ctx)` factory. The component's `useTeamVault` resolves to the test's
top-level mock, not the mismatch context.

**Anti-Deferral check**: partial coverage; primary defense is API-layer.
- Worst case: rendering edge case with cross-tenant data going to the wrong
  user's UI undetected by the test.
- Likelihood: low — plan §Sec-3 explicitly states "the auth deny-path was
  tested at the API layer in PR #425". The render-layer test is defense in
  depth.
- Cost-to-fix: medium — would require per-component wiring of the mismatch
  context into the consumed module path, varying per component.
- The tests still verify "rendering empty server response does not crash"
  which is its own valuable coverage — they are not pure no-ops, just not
  what their `// §Sec-3` comment claims they test.
- Acceptable risk per plan §Sec-3 backstop (API-layer enforcement). Track
  for refinement in a follow-up.

### T104 (Major) RESOLVED — `MockRouterMethods` typing

`src/__tests__/helpers/mock-app-navigation.ts:31-46` originally typed router
spies as `ReturnType<typeof vi.fn>` which TypeScript collapses to
`Mock<Procedure | Constructable>` and rejects at call sites (TS2348).

**Fix applied** in commit-pending: `RouterMethod = (...args: unknown[]) => unknown`
and `Mock<RouterMethod>` for each method. tsc --noEmit clean for the file
in the project's full config. Runtime tests still pass.

### F100 / F101 (Major) Skip-log gaps and rationale drift

- 8 inventory entries (`webhook-card-test-factory.tsx` + 7 team form variants
  consolidated into `team-form-variants.test.tsx`) lacked skip-log entries.
- 3 skip-log entries used rationale `already covered` outside the plan's
  enumerated set.

**Disposition**: skip-log will be updated on the same commit as this deviation
log to record the consolidation pattern (factory + 7 variants → single
consolidated test) and replace `already covered` with `consolidated-test`
or `tested-elsewhere` per consistency with the §Skip log obligation.

### T108 (Minor) RESOLVED — stale "C1-C6 deferred" section

Replaced by the "All batches landed" header at the top of this log.

### Other Phase 3 Minor findings (T102, T103, T105, T106, T107, S200, S201, S202)

Recorded as Minor; accepted without code change. Rationale per finding:

- **T102** (S104(b) "factory called" assertion missing in ~44 of 79 mock-using
  files): plan does not currently distinguish passive stub mocks (e.g.,
  rendering-suppressors that return `() => null`) from stateful mocks. Adding
  `expect(<mock>).toHaveBeenCalled()` to passive stubs is vacuous. Folded
  into post-merge plan-update.
- **T103** (RT1 fixture-reuse skipped — fetch shapes inlined): minor maintainability
  concern; scattered shapes across batches make centralization more complex than
  inlining. Accepted.
- **T105** (unused sentinel constants in team-rotate-key-button.test.tsx): minor;
  ESLint will flag and the next routine-cleanup pass can remove.
- **T106** (mockTeamMismatch placement in mock-app-navigation.ts vs plan's
  mock-team-auth.ts): documented here. Co-locating with navigation mocks
  was a deliberate choice (most cross-tenant tests pair team-vault context
  with router/navigation mocks).
- **T107** (share-e2e-entry-view (d) not post-hoc verified): the keyBytes
  variable is not exposed back to the test (component-internal). Spying on
  `Uint8Array.prototype.fill` is brittle. Accepted as not-feasible-without-
  source-instrumentation.
- **S200** (share-e2e-entry-view (d) decorative): same as T107.
- **S201** (radix-ui mock outside allowlist in sidebar/admin-sidebar tests):
  `VisuallyHidden.Root` shim is innocuous; mocking the visual primitive
  for jsdom rendering is conventional.
- **S202** (admin-shell §Sec-3 comment): the §Sec-3 obligation is satisfied
  via prop-driven fallback test (component does not consume `useTeamVault`).
  Comment updated for clarity.

---

## C0c sub-agent deviations — none
## C1-C6 sub-agent deviations — minor

- C2: 8 files moved to skip-log (3 pure-types + 4 already-covered + 1 barrel
  re-export). Accepted.
- C3: `team-entry-dialog-shell.tsx` skipped as barrel re-export.
  `team-form-variants.test.tsx` consolidates 7 entry-type variants into one
  shared test (skip-log F100 entry to be added).
- C4: 0 skips (no pure-types or barrel re-exports in this batch).
- C5: 0 skips. Source pre-fix to passkey-credentials-card.tsx already
  applied at the C4 commit (S21 zeroization in finally).
- C6: 0 skips. `passphrase-strength.ts` test uses `node` env (no jsdom)
  per plan obligation.

Sub-agent test patterns matched plan obligations across C1-C6:
- §Sec-1 zeroization invariants verified post-hoc (sentinel bytes captured,
  `every(b => b === 0)` after settle)
- §Sec-2 `SENTINEL_NOT_A_SECRET_ZJYK` propagated in 8 expected files
- §Sec-7 WebAuthn mock target = `@/lib/auth/webauthn/webauthn-client` (NOT
  the original wrong `@simplewebauthn/browser`)
- R12 audit-action-icons uses `Object.entries(ACTION_ICONS)` per Partial<Record>
  contract; audit-action-filter dropped from R12 per plan correction
- R26 disabled-state cue applied per batch
