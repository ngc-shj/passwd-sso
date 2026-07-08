# Code Review: step-up-client-policy-card
Date: 2026-07-08
Review round: 1 (triangulate Phase 3)

## Changes from Previous Round
Initial code review of the committed Phase 2 implementation (037765fe), on top of the
Phase 2 self-R-check baseline and two prior external review passes (F1/F2, already fixed
and committed).

## Functionality Findings
No novel findings survived verification. The functionality expert verified: discriminated
retry replay targets the correct handler+arg for every multi-mutation component; the
permanent-delete rollback (reload before reauth) is correct and empty-trash/bulk-purge
have no analogous phantom-state risk; base-webhook stacked markers replay create vs delete
correctly; every client `@stepup` marker has its branch token within the adjacency window;
the guard exits 0 and its logic has no false-PASS beyond the two documented limits; all
Implementation-Checklist files appear in the diff.

Seed dispositions:
- `use-bulk-action.ts:128` silent-swallow (Ollama Major) — Rejected as a live bug
  (unreachable: the sole consumer always passes `onStepUpRequired`), but re-tagged
  **[Adjacent] Minor** as an API-design latent trap. → **Fixed** (see Resolution T3).
- `mcp-client-card / api-key-manager / access-request-card` "bypasses shared helper"
  (Ollama Minor ×3) — Rejected: intentional raw-literal branches where the parsed body is
  reused for other error codes (a `handleStepUpError` swap would double-consume
  `res.json()`); documented in deviation D2; each still carries a correct marker+branch.

## Security Findings
**No findings.** The security expert verified all six focus areas: no guard false-PASS
surface beyond the two documented limits (`.test.` exclusion anchored, `is_exempt` exact
match, adjacency window has no real bleed-through, multi-line calls anchor correctly); no
step-up bypass introduced (every marker is a pure comment above an unchanged
`requireRecentCurrentAuthMethod` call with its `if (stepUp) return` intact); passwords &
team-passwords DELETE gated only inside `if (permanent)`, soft-delete frictionless; the
phantom-delete fix uses a genuine server re-fetch and has no residual leak; all 3 exempt
ids are legitimately custom-recovery / non-interactive (operator-tokens uses a custom
`errorCode` override so it structurally never emits the standard code); no info leak in the
typed error or helper.

## Testing Findings
- **[T1] [Major] bulk-purge hook step-up branch has no direct unit test** —
  `src/hooks/bulk/use-bulk-action.ts` executeAction's step-up branch was proven only by
  proxy through a fully-mocked consumer. → **Fixed** (Resolution T1).
- **[T2] [Major] team-scope permanent-delete / empty-trash step-up untested at every
  level** — the personal & team vault-list adapters' `throwIfStepUp` had zero direct
  coverage; the team-scope path was untested at unit/integration/E2E despite guard
  satisfaction. → **Fixed** (Resolution T2).

Seed dispositions (all refuted / disclosed): the E2E shared-session mutation is handled by
an `afterAll refreshSessionRecency`; tenant-members-card mocks reset in `beforeEach`;
fixture viii's existence-level pairing is a documented tradeoff. The expert empirically
reverted the adjacency check to a whole-file grep and confirmed ONLY fixture vii flips —
proving it is the sole regression lock for the file-scoped-grep bug class.

## Adjacent Findings
- **[T3 / Adjacent] [Minor] use-bulk-action `onStepUpRequired` optional-field trap** — an
  omitted `onStepUpRequired` would let the no-op `?.()` make `handleStepUpError` return
  true, silently closing the dialog with no toast. → **Fixed** (Resolution T3).

## Recurring Issue Check
- R1/R2 (reuse): shared helper extracted per user steer; no duplicated step-up block. Clean.
- R19 (all test trees): every touched component's co-located test updated; full suite green. Clean.
- R42 (class member-set): 45 members derived from the defining primitive; closed by the
  mutation-verified CI guard (see Environment Verification Report). Clean.
- Forbidden patterns (plan): step-up branch in `!res.ok` not catch; no hardcoded "cancel";
  no `@prisma/client` in guard. Grep-verified clean.
- RS1 (timing-safe), R36 (suppression), RT4 (race-vacuous): N/A to this diff.

## Environment Verification Report
Phase 1 declared the step-up 403 path unit-testable (mock fetchApi → 403) and the
browser/E2E stale-window path as `verifiable-local`.
- Unit denial tests (per component × gated method) + helper test + adapter/hook step-up
  tests: **verified-local** — `npx vitest run` 12086 pass.
- C1 guard: **verified-local** — `bash scripts/checks/check-step-up-client-coverage.sh`
  exit 0; 10-fixture self-test pass; mutation-proven (reverting adjacency→file-scope flips
  only fixture vii; removing a client marker goes RED via S\C).
- E2E `step-up-stale-window.spec.ts` + existing `trash.spec.ts`: **blocked-deferred** —
  the full E2E stack (Postgres+Redis+Jackson+Next server, seeded via global-setup) is not
  up in this environment and E2E is outside pre-pr's default gate
  (project_ci_gates_beyond_pre_pr, declared in Phase 1 / plan §Verification). Spec authored
  and type-consistent with the page objects; run when the stack is available. Deviation
  D5 records the justification.
- **R42 class `step-up-client-coverage`: member-set expanded ~24→45 (≥2×) — closed by
  mutation-verified CI guard `scripts/checks/check-step-up-client-coverage.sh` (red-proven:
  remove a client `@stepup` marker → MISSING_CLIENT_MARKER; revert adjacency→file-scope →
  fixture vii FAILs), wired in `scripts/pre-pr.sh:166` → CI `static-checks` job
  (`PRE_PR_STATIC_ONLY=1`).**

## Resolution Status

### T1 [Major] bulk-purge hook step-up branch untested — Fixed
- Action: added a `describe("step-up handling")` block to use-bulk-action.test.ts (3 tests):
  deletePermanently+403+handler → onStepUpRequired called, dialog closed, no error toast;
  deletePermanently+403 with handler omitted → generic error toast (not swallowed);
  non-purge action+403 → onStepUpRequired NOT called.
- Modified file: src/hooks/bulk/use-bulk-action.test.ts

### T2 [Major] team-scope adapter step-up untested — Fixed
- Action: added 3 tests each to personal- and team-vault-list-adapter.test.ts:
  deletePermanently & emptyTrash on 403 → reject with StepUpRequiredError
  (isStepUpRequiredError true); an ungated method (restore) on 403 → plain Error.
- Modified files: src/lib/vault/personal-vault-list-adapter.test.ts,
  src/lib/vault/team-vault-list-adapter.test.ts

### T3 [Adjacent Minor] use-bulk-action onStepUpRequired optional-field trap — Fixed
- Action: gated the step-up branch on `pendingAction === "deletePermanently" &&
  onStepUpRequired` so an omitted handler falls through to the generic error toast instead
  of silently closing the dialog. Regression-locked by the T1 "handler omitted" test.
- Modified file: src/hooks/bulk/use-bulk-action.ts

### R35 Tier-2 manual-test artifact — Added
- Action: admin-IA pages (C3) trigger the R35 Tier-1 pre-pr gate; authored a Tier-2
  manual-test plan (Pre-conditions / per-surface scenarios / 4 Adversarial scenarios incl.
  the phantom-delete ADV-1 and reauth-replay-target ADV-4 / Rollback).
- Added file: docs/archive/review/step-up-client-policy-card-manual-test.md
