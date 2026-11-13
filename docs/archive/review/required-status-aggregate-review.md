# Plan Review: required-status-aggregate
Date: 2026-11-13
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen unavailable (Ollama down).

## Functionality Findings
- F1 Major (design) — SC2's `PATCH .../protection/required_status_checks` returns 404 while no
  check is enabled; the active ruleset 13001033 was ignored; read-back covered classic only.
  → Fixed: SC2 adds a `required_status_checks` rule to the ruleset with `integration_id`;
  read-back via `rules/branches/main`.
- F2 Major (design) — the gated-`if` rule had no defined subject; `app-coverage` and `e2e`
  carry other forms. → Fixed: C3 rule 7 is a closed grammar over every job-level `if` (FC,
  AFTER, FC-AFTER), rule 9 applies "every job gated" per workflow via `everyJobGated`.
- F3 Major (design) — `continue-on-error` forbidden in prose but only checked on some jobs.
  → Fixed: C3 rule 6 covers job and step level on every job.
- F4 Minor (prose) — `CONTRIBUTING.md:59` claims ci-integration blocks merge. → Fixed (R4, C4).
- F5 Minor (prose) — SC1 named non-`pull_request` workflows; `merge_group`. → Fixed (SC1, C4).
- F6 Minor (design) — the aggregate name, matrix and uniqueness were not pinned. → Fixed
  (C3 rules 2–3, name-collision check).
- F7 Minor (design) — the `changes` job name, checkout and quoting were unspecified. → Fixed
  (Technical approach).
- F8 Minor (prose) — the retargeted-PR `edited` case and a `changes`-only failure. → Fixed
  (C4 recovery notes, scenarios).

## Security Findings
- S1 Major (design) — the aggregates and the gate run from the PR's own head; the
  CODEOWNERS "primary control" claim is false (0 approvals, code-owner review off). → Fixed:
  Threat model section, C4 ops note, R4 corrects the supply-chain gate header. Fork approval
  policy recorded as SC3 (repository setting, user decision).
- S2 Major (design) — required names spoofable: no app pin, no cross-workflow uniqueness. →
  Fixed: `integration_id: 15368` in SC2; C3 name-collision check over the directory listing.
- S3 Major (design) — skipped = pass; `ci.yml` job `if`s unchecked; substring match. →
  Fixed: C3 rule 7, exact match after normalisation, `github.`/`vars.`/`inputs.` rejected.
- S4 Minor (design) — aggregate step not fully pinned; printing `outputs`. → Fixed (C3 rules
  3–4; step prints `id: result` only).
- S5 Minor (design) — PR files API caps at 3000 files. → Fixed: large-PR guard in both
  `changes` jobs, outputs `|| 'true'`, C3 rule 10.
- S6 Minor (design) — checkout and permissions of new jobs. → Fixed: no checkout in the new
  `changes`; aggregate `permissions: {}`; C3 rule 8.
- S7 Minor (prose) — SC1 wrong; CodeQL; `merge_group`. → Fixed (SC1, C4).
- S8 Minor (design) — `strict` undecided. → Fixed: SC2 leaves it to the user with a `true`
  recommendation and its cost.
- S9 Minor [Adjacent] — `sha_pinning_required` off, workflows may approve PRs. → Recorded as
  SC3.

## Testing Findings
- T1 Major (design) — the step test must run as GitHub does (`bash -e`), forbid `${{` in
  `run`, pin the `env` binding. → Fixed (C3 rule 4, Testing strategy).
- T2 Major (design) — `needs` fixture shape unspecified; missing/null `result`. → Fixed (C2
  decision input and acceptance rows). A fixture copied from a real run is not added: the
  step prints only `id: result`, and the shape is GitHub's documented one.
- T3 Major (design) — red-proof covered two mutations. → Fixed: one mutation per rule and per
  step branch; `checkRepository` injectable for the fail-loud cells.
- T4 Major (design) — `if` without `always()` / `&&`-joined clause. → Fixed (rule 7 cells).
- T5 Major (design) — aggregate name and `strategy` unchecked. → Fixed (rules 2–3).
- T6 Major (design) — red side observed only after protection; names not read back. → Fixed:
  CI order 1–4, check-run read-back with app id before SC2, scratch PR B shows the matrix
  collapse and `CI result` red.
- T7 Minor (design) — divergence compared `run` only; one file executed. → Fixed.
- T8 Minor (prose) — the docs-only scratch PR must avoid `docs/operations/**`. → Fixed
  (`docs/archive/**`, expected conclusions listed).
- T9 Minor (design) — no check that the filter equals the old trigger. → Fixed (one-time diff
  plus a dead-pattern cell).
- T10 Minor (design) — trigger rule vacuous when `pull_request` absent or `types` narrowed. →
  Fixed (rule 1).
- T11 Minor (design) — jq absent must fail, not skip. → Fixed (sentinel cell).

## Adjacent Findings
- S9 (above). Functionality's adjacent note on the unpinned app is S2.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R1 checked (jq rather than alls-green; gate shape follows check-workflow-supply-chain).
- R2 checked → F6. R3 checked → F2, F3. R16 checked. R17–R20 checked (F7 quoting).
- R22 checked → F2 (app-coverage exception). R29 checked → F1, F5. R31 checked (protection
  overwrite risk, F1). R33 checked. R34 checked → F4. R35 checked. R36 → F3. R38 → F8.
- R41 → F1. R42 checked (22 + 2 jobs re-derived) → F4, F5. R44, R47, R48, R50, R52 checked.
  R49 → F3. R51 → F6.
- R4–R15, R21, R23–R28, R30, R32, R37, R39, R40, R43, R45, R46, R53–R57: N/A.

### Security expert
- R1 N/A. R2 checked (S2). R3 → S3. R16 checked. R29 → S7. R33 → S5. R34 → S1. R35 checked.
  R36 → S4. R42 → S2. R44 → S2. R47 → S3. R49 → S1. R50 checked. R51 → S2.
- All other R items N/A.
- RS1, RS2 N/A. RS3 checked (`toJSON(needs)` via env, not inline). RS4 checked. RS5, RS6 N/A.

### Testing expert
- R2 → T5. R3 checked (T7). R16 → T1. R29 → T6. R33 → T7. R42 checked. R44 → T1. R47 → T4.
  R48 noted. R49 checked. R50 → T6. R51 → T5.
- All other R items N/A.
- RT1 → T1, T2. RT2 checked. RT3, RT4 N/A. RT5 → T1. RT6 → T3. RT7 → T3. RT8 N/A. RT9 → T7.
  RT10 checked. RT11 → T1 (temp file cleanup).

## Round 2 (2026-11-13)

Changes from Round 1: plan rewritten per all round-1 findings (ruleset-based SC2, closed `if`
grammar, cross-workflow name uniqueness, large-PR guard, threat model, per-step pinning).

All round-1 fixes verified by their filers. No Critical. New findings:

### Functionality
- N1 Minor (design) — step-level `if` unchecked. → Fixed: C3 rule 11.
- N2 Minor (design) — rule 10 checked guard presence only. → Fixed: guard deep-equals a
  canonical object, filter `if` exact, guard executed (Testing).
- N3 Minor (design) — scratch PR A cannot be docs-only before merge. → Fixed: CI order
  merges first, then A/B from new `main`.
- N4 Minor (prose) — job counts. → Fixed (before/after counts with derivation).
- N5 Minor [Adjacent] (prose) — CODEOWNERS-enforcement claims elsewhere. → Fixed: R4 member
  set from a recorded `git grep`, all reworded.

### Security
- N1 Minor (design) — aggregate shell/env reachable via `defaults` / workflow `env`. →
  Fixed: rule 3 extended; step starts `set -euo pipefail`.
- N2 Minor (design) — step-level `if`. → Fixed (rule 11, same as Functionality N1).
- N3 Minor (design) — AFTER / FC-AFTER accept any dependency. → Fixed: enumerated pairs.
- N4 Minor (design) — guard threshold/`if` unpinned. → Fixed (as Functionality N2).
- N5 Minor (design) — expression-bearing names. → Fixed: literal-parts pattern match.
- N6 Minor (design) — top-level permissions. → Fixed: rule 8.
- N7 Minor (prose) — threat-model path list; 3000-file citation. → Fixed: "any file CI
  executes or reads"; GitHub REST reference cited, guard fail-closed regardless.

### Testing
- F1 Major (design) — clause-level red cells missing (unknown filter key, AFTER variants,
  rules 2/3/4/8/9/10). → Fixed: one cell per clause id, shared with the red-proof list.
- F2 Major (design) — the guard decision never executed. → Fixed: guard executed from both
  workflows for 0/2999/3000/3001/empty/abc; inverted-comparison mutation.
- F3 Minor (design) — step mutations for null/missing result and parse error. → Fixed.
- F4 Minor (prose) — A/B timing. → Fixed (as Functionality N3).
- F5 Minor (design) — per-job conclusions for PR B. → Fixed.
- F6 Minor (design) — check-run pagination / reruns. → Fixed: `check_name` filter, newest
  `completed_at`, `statusCheckRollup`.
- F7 Minor (design) — transitive picomatch, overclaim. → Fixed: claim narrowed to "matches
  nothing", version noted; narrowing is caught by the one-time diff.
- F8 Minor (prose) — exit-code contract. → Fixed: explicit `exit 1`, exact status asserted.

### Scope note
Security's round-2 vectors that need a hostile PR author (shell/env override, expression
names) are cheap and were taken; the Threat model now states that C3 targets accidental
weakening, so further hostile-only vectors are recorded as known limits rather than new
rules.

### Recurring Issue Check (round 2)
- Functionality: R3 → N1; R29 → N4; R34, R42 → N5; R35, R41 → N3; R49 → N1; R53 → N2;
  R1, R2, R16–R20, R22, R31, R33, R36, R38, R44, R47, R48, R50–R52 checked; others N/A.
- Security: R3, R49 → N2; R29 → N7; R52 → N1; R53 → N4; R2, R16, R33–R36, R42, R44, R47,
  R50, R51 checked; others N/A. RS3, RS4 checked; RS1, RS2, RS5, RS6 N/A.
- Testing: R29, R48 → F7; R44 → F8; R50 → F4, F6; R2, R3, R16, R33, R42, R47, R49, R51,
  R55 checked; others N/A. RT5 → F2; RT7 → F1–F3; RT8 → F5, F6; RT10 → F1; RT1, RT2, RT6,
  RT9, RT11 checked; RT3, RT4 N/A.

## Round 3 (2026-11-13)

Changes from Round 2: rule 3/7/8/10/11 extensions, guard contract, R4 member set, CI order
1–5, testing strategy rewritten per clause.

All round-2 fixes verified by their filers against the real workflows (rules 3, 7, 8, 11 and
the dead-pattern cell pass on today's files). No Critical, no Major. New findings, all Minor:

- Functionality P1 / Security P1 (prose; converged) — R4's grep missed `.github/CODEOWNERS:1,2,18,48`
  and `check-workflow-supply-chain.mjs:20,93`. → Fixed: grep widened, list re-derived, the
  one false positive (`docs/security/license-policy.md:38`, license metadata) excluded by name.
- Functionality P2 / Testing G1 (converged) — PR B's forced failure must live inside `run`,
  or rule 11 reds `static-checks`. → Fixed.
- Testing G2 (design) — guard cells must assert exit 0 and `small=false` presence. → Fixed.
- Testing G3 (design) — collision pattern needs metacharacter cells. → Fixed.

### Saturation call
Round 3 is the third completed round. No Critical or Major finding is open in any category;
no round-3 finding is against a contract, control class or invariant (P1 is prose, P2/G1 an
acceptance-procedure detail, G2/G3 added test cells for already-specified behaviour); every
round-3 finding was applied, so none is carried forward. The plan phase is closed by the
saturation exit rather than a fourth round over these four small edits.

### Recurring Issue Check (round 3)
- Functionality: R34, R42 → P1; R35 → P2; R1–R3, R16–R20, R22, R29, R31, R33, R36, R38, R41,
  R44, R47–R53 checked; others N/A.
- Security: R42 → P1; R2, R3, R16, R29, R33–R36, R44, R47, R49–R53 checked; others N/A.
  RS3, RS4 checked; RS1, RS2, RS5, RS6 N/A.
- Testing: R47 → G3; R50 → G1; R44 → G2; R1–R3, R16, R29, R33, R42, R48, R49, R51, R55
  checked; others N/A. RT8 → G2; RT10 → G3; RT1, RT2, RT5–RT7, RT9, RT11 checked; RT3, RT4 N/A.
