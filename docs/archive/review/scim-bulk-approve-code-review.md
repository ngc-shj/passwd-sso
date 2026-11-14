# Code Review: scim-bulk-approve

Date: 2026-11-14
Review round: 1

## Changes from Previous Round

Initial review. Local LLM pre-screening and seeds were unavailable (Ollama down); the experts
reviewed the full diff. Findings deduplicated by hand from the experts' json indexes; no two
experts reported the same finding.

## Functionality Findings

- F1 Minor — `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx`, the bulk-reject
  dialog: its body reused the single reject's text ("Reject this pending membership? … this
  user …"), which speaks of one row under a title that says "Reject all (N)".
- F2 Minor — same file, the bulk button row has no bottom margin before the list.

Checklist cross-check: every file in the plan's Implementation Checklist is in the diff; the one
addition beyond it is the `check-bypass-rls.mjs` allowlist entry (deviation D5).

## Security Findings

- S1 Major — `scripts/checks/check-team-rotation-input-lock.mjs`, `resolveSpecifier`: the `@/`
  branch was not normalised, so `@/lib/team/../team/scim-admission` and
  `@/lib//team/scim-admission` resolved to a path that is not equal to the module's, and the
  importer allowlist (V7(b)) and the audit-import allowlist (V7(d)) did not see them. TypeScript
  resolves both spellings to the real file. Attacker / precondition: a contributor or a careless
  change adding a fifth importer (an admission path without step-up or limiter) in one of those
  spellings; CI stays green. (R46/R47.)
- S2 Minor — `scripts/checks/check-bypass-rls.mjs`: the `POOL_RULE_ALLOWLIST` entry for the new
  integration test is sound (the file only spies on `Client.prototype.query`) but is a per-file
  exemption, like the entries beside it.

Verified with no finding: the two single routes diffed against `origin/main` keep every control
(session, permission, step-up, limiter and its order, uuid check, pre-read and locked re-read,
lock order, lock-conflict mapping, in-transaction audit, outcome-to-status mapping); the bulk
routes carry the same stack; absent, other-team and active ids all answer `not_found`.

## Testing Findings

- T1 Minor — gate self-tests: the `import x = require()` branch of `moduleReferences` and the
  bare `@/lib/audit` specifier arm have no self-test and no red-proof (RT7).
- T2 Minor — `page.test.tsx`: the "no request after cancel" half cannot fail; the file's mocked
  `AlertDialogCancel` drops its props.
- T3 Minor — bulk route tests do not pin the permission argument, the limiter key, or the
  transaction timeout value.
- T4 Minor — `scim-admission.test.ts`: the `findFirst` mock ignores `select`, so the dormant
  departed-actor tests would pass a resolution that forgets to select `admittedAt` / `createdAt`.
- T5 Minor — `page.test.tsx`: the bulk-reject success test does not assert the list reload.

Plan coverage, item by item: U1–U4 present; U5 present except T1's two branches; B1–B8 present
and at least as strong as specified. Tripwire on this branch: the four
`runIf(hasDepartedActorCheck)` tests are skipped, the absence test and the schema-read test run.

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert

- R1–R25, R27–R57: applied to the changed patterns, no finding in scope; registries (manifest,
  step-up paths, fail-closed count 75 → 77, route-policy matrix) and the e2e grep clean.
- R26: noted — neither the bulk nor the existing per-row buttons have an in-flight disabled
  state; consistent with the existing handlers, no finding.
- R29: citations in new comments and docs verified.
- N/A: the migration and schema rules (no schema change).

### Security expert

- R1–R57, RS1–RS6 applied against the code read. Clean: authz and tenancy, step-up, rate
  limiting (RS2), audit atomicity, input validation (RS3), lock ordering, information disclosure,
  id case consistency, single-route refactor parity.
- R46/R47: Finding S1.
- N/A: crypto, vault, session and token rules. The expert noted it applied the rules from the
  code read rather than extracting each digest row.

### Testing expert

- R1, R2 Checked; R3 Checked (AC1 holds); R8, R10, R12 Checked; R16–R19 Checked; R21 Checked
  (unit tests re-run); R29 Checked; R36 Checked; R42 Checked (T1 notes two untested members of
  the reference-kind class); R44, R50 Checked.
- N/A: R4–R7, R9, R11, R13–R15, R20, R22–R28, R30–R35, R37–R41, R43, R45–R49, R51–R57.
- RT1 T4; RT2 T2; RT3–RT6 Checked; RT7 T1; RT8, RT9 Checked; RT10 Checked; RT11 Checked.

## Environment Verification Report

- VE1 (no IdP; pending rows created through the SCIM routes): `verified-local` —
  `npx vitest run --config vitest.integration.config.ts
  src/__tests__/db-integration/scim-bulk-approve.integration.test.ts`, 11/11, three runs
  (deviation D1, D6).
- VE2 (step-up dialog in a real browser): `blocked-deferred` — the manual test plan
  `scim-bulk-approve-manual-test.md` is written but not executed in this session. Plan entry VE2
  and scope item SC4. Worst case: the bulk buttons' step-up retry misbehaves in a real browser
  (the unit test pins that the retry replays the captured body; the single-row actions on the
  same page use the same hook). Likelihood: low. Cost to fix: a manual pass of the document
  against a dev stack by a person with a registered passkey.
- VE3 (production round-trip latency): `blocked-deferred` — plan entry VE3; bounded by the
  statement count instead (453 × 3 ms = 1359 ms, deviation D1).

## Resolution Status

### S1 Major — gate rule 7 did not normalise `@/` specifiers
- Action: `resolveSpecifier` normalises both the alias and the relative form. Three deny
  self-tests added (alias detour through a parent segment, doubled slash, the audit-lib detour).
  Red-proved: the three fail against the pre-fix gate (`git show HEAD:` copy in a scratch tree,
  3 failed / 87 passed) and pass with the fix. Allow side: the four routes and the near-named
  constants file still pass.
- Modified file: `scripts/checks/check-team-rotation-input-lock.mjs` (`resolveSpecifier`),
  `scripts/__tests__/check-team-rotation-input-lock.test.mjs`.

### F1 Minor — bulk-reject dialog reused the singular text
- Action: new `bulkRejectConfirm` key (en, ja) stating the count; the dialog uses it; the page
  test asserts it.
- Modified file: `messages/en/Team.json`, `messages/ja/Team.json`, the members page and its test.

### F2 Minor — bulk button row spacing — Skipped
- Anti-Deferral check: not a defect. The row is a child of `CardContent className="space-y-4"`,
  which already separates it from the list; the note above it carries `mb-2` only because it is
  followed by nothing but that same spacing. Worst case: none (visual preference). Likelihood:
  n/a. Cost to fix: one class, at the price of a double gap.

### S2 Minor — per-file allowlist entry in `check-bypass-rls` — Accepted
- Anti-Deferral check: the reviewer judged the entry sound and asked for no change. Worst case: a
  later edit adds a real pool to that test file and the pool rule does not see it. Likelihood:
  low (seven sibling test files carry the same exemption). Cost to fix: making the allowlist
  per-construct instead of per-file, a change to a shared gate outside this feature.

### T1 Minor — two gate branches without a self-test
- Action: tests for `import x = require()` of the module and for a bare `@/lib/audit` import in
  an admission route. Red-proved separately on scratch copies of the gate (each mutation fails
  exactly its new test; control 92 passed).
- Modified file: `scripts/__tests__/check-team-rotation-input-lock.test.mjs`.

### T2 Minor — the cancel half of a page test could not fail
- Action: the test file's mocked `AlertDialogCancel` forwards `onClick`, so a handler wired to
  cancel would run.
- Modified file: the members page test.

### T3 Minor — bulk route tests did not pin permission, limiter key, timeout
- Action: both route tests assert `requireTeamPermission(actor, team, MEMBER_INVITE, …)`, the
  transaction options `{ timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS }`, the limiter key, and the
  limiter's `max: 10` (the fail-closed option is pinned by the Redis-down contract test; naming
  it in an assertion is counted by `check-fail-closed-routes-have-test`'s instantiation grep, which
  the full suite caught). Red-proved on scratch copies of each
  route (permission, key, timeout, max: each fails the test).
- Modified file: `bulk-approve/route.test.ts`, `bulk-reject/route.test.ts`.

### T4 Minor — tripwire mock ignored `select`
- Action: the module test's `findFirst` mock projects the row through `select`, so a read that
  does not select `admittedAt` / `createdAt` receives neither. No red-proof on this branch: the
  tests it serves are the `runIf(hasDepartedActorCheck)` ones, skipped until #1035's column or
  predicate is in the tree.
- Modified file: `src/lib/team/scim-admission.test.ts`.

### T5 Minor — bulk-reject success did not assert the reload
- Action: the test asserts the members list is fetched again. Red-proved on a scratch copy of
  the page with `fetchAll()` removed from `handleBulkReject`.
- Modified file: the members page test.
