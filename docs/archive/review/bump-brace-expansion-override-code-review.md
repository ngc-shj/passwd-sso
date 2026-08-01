# Code Review: bump-brace-expansion-override

Date: 2026-08-01
Review round: 1

## Changes from Previous Round

Initial code review. Phase 2's Step 2-5 self-check ran first and returned **No findings**
from the Functionality and Security lanes; the **Testing lane returned a Critical R50**
(`pre-pr` reported 61 passed while having skipped Lint / Typecheck / Test / Build),
recorded as D5. Round 1 here is incremental verification on top of that baseline.

## Merge method

Mechanical json-index join across the three experts. Findings are disjoint by
`(file, line ±5)`; no prose merge needed. Recorded per the Step 3-4 fallback clause.

Local LLM pre-screening (`pre-review.sh code`): one finding, **rejected**. It claimed the
runbook writes `--audit-level-high` instead of `--audit-level=high`. Verified false —
`grep -rn -- '--audit-level-high'` over `docs/`, `scripts/`, `.github/` returns nothing,
and all five occurrences in the runbook use the correct `=` form. A hallucinated typo.

## Functionality Findings

**No findings.**

The reviewer independently re-derived the advisory bands (`gh api` for
`GHSA-mh99-v99m-4gvg`, `GHSA-3jxr-9vmj-r5cp`, and all nine non-withdrawn `js-yaml`
advisories), the resolved versions (from the lockfile, `node_modules/`-anchored), the
`Dockerfile` `BE_VER` claim, and both audit scopes — every one matched. It also read the
runbook end to end hunting for a fourth false-parity occurrence after D1's third: none in
the runbook; the only other repo hits are historical `docs/archive/review/*` artifacts
from unrelated merged PRs and the CHANGELOG, none restating this PR's claims.

It concurred with D2's disposition (leaving Step 2's `rm -rf node_modules
package-lock.json` guidance unchanged), on the grounds that a full regeneration is a
legitimate general recommendation and the in-place `npm install` used here was a
situational choice to keep the diff bounded — not a universal rule the runbook should
adopt.

## Security Findings

### F1 [Major] — The runbook's disjointness check is unsound for inclusive upper bounds

- **File**: `docs/security/dependency-cve-response.md` (Step 4)
- **Problem**: the check is stated as *"sort the keys by lower bound; each key's lower
  bound must be `>=` the previous key's upper bound."* That is valid only for half-open,
  exclusive-upper ranges — the form every key this PR ships happens to use, and which the
  text never requires. With an inclusive upper bound the check gives a false "disjoint"
  verdict for keys that overlap at exactly one version:

  ```json
  {"brace-expansion@<=1.1.17": "1.1.17", "brace-expansion@>=1.1.17 <2.0.0": "1.1.16"}
  ```

  `1.1.17 >= 1.1.17`, so the check passes — but both keys select 1.1.17, and npm resolves
  it by JSON key order. Reviewer's empirical result: the order above resolves **1.1.17**;
  reversed, it resolves **1.1.16**, the vulnerable version. Exit 0, no diagnostic, either
  way.
- **Why it matters**: this is a verifier whose own input space was never derived. It was
  checked against the keys at hand and generalized to a rule future responders will apply
  to keys nobody has written yet — the same shape as R42's "the seed is not the set",
  applied to a check rather than a control.
- **Scope**: not a defect in this PR's six shipped keys, which are all exclusive-upper and
  verified genuinely disjoint. It is a defect in the guidance the PR adds.

**Assessment: ACCEPTED, fixed.** Step 4 now requires half-open exclusive-upper ranges,
states that the disjointness check is valid only for that form, shows the counterexample,
and gives the escape hatch (strict `>` on the adjacent key) if an inclusive bound is
unavoidable.

### F2 [Major] — The runbook presents `npm run pre-pr` as covering lint/test/build with no commit-first caveat

- **File**: `docs/security/dependency-cve-response.md` (Step 2 command block, Step 3,
  Quick reference)
- **Problem**: C5 correctly removed the false "`pre-pr` runs the same `npm audit`" claim,
  but every remaining `npm run pre-pr` mention is presented flatly as "lint / test / build
  / static gates" with no caveat. `detect_web_changes()` gates those four steps on the
  **committed** diff. A responder who edits `package.json`, runs `npm install`, then runs
  `pre-pr` — exactly the order Step 2's own command block implies — gets those steps
  silently skipped whenever the branch's prior commits are docs-only, which is a very
  plausible shape for a CVE-response branch that starts with a plan edit.
- **Why it matters**: this is the same defect class C5 was written to fix, left standing
  for the adjacent claim. And D5 is the proof it bites: this PR's own Phase 2 fell into it
  on this branch, with the governing memory already on record.

**Assessment: ACCEPTED, fixed.** Step 3 now states the committed-diff gating, names
`PRE_PR_FORCE_FULL=1`, and gives the ANSI-stripped grep to confirm the four steps
actually ran rather than trusting the pass count.

### Security verification that found no discrepancy

- Class A / B / C all re-derived from primitives. Thirteen Class C rows re-derived from
  the **committed lockfiles** (never `npm ls`) against live `gh api` data — including
  `postcss` root 8.5.22 / cli 8.5.23 (both above the `<= 8.5.17` high advisory's 8.5.18
  ceiling), `effect` 3.22.0, `esbuild` 0.28.1, `extension`'s `undici` 7.28.0. Every
  verdict matches the plan's table; no new gap.
- The replaced `brace-expansion` key is confirmed a strict superset; the four resolved
  5.0.8 copies are outside both the old and new selector, so the widening cannot regress
  them. No band above 5.0.8 exists in any current advisory.
- **SC7's empirical claim tested directly**: pinning `js-yaml@2.0.5` (inside the
  deliberately-uncovered `< 3.0.0` band) in a scratch project with no override present,
  `npm audit` **does** report it as critical. The claim "if a `< 3.0.0` copy ever appears,
  `npm audit` will catch it" is true, not aspirational. SC7's cost-justification stands.
- The first-match ordering hazard was reproduced independently for this PR's actual key
  shape and confirmed **not** to apply — order is irrelevant for genuinely disjoint keys.

## Testing Findings

### F3 [Major] — D5's cited evidence grep can never match, in either direction

- **File**: `docs/archive/review/bump-brace-expansion-override-deviation.md` (D5)
- **Problem**: D5 cited `grep -cE '▸ (Lint|Test|Build|Typecheck)$'` returning 0 as proof
  the four web steps were skipped. `scripts/pre-pr.sh` colorizes every step label
  unconditionally, so the bytes are `\x1b[1m▸ Lint\x1b[0m` — the reset escape sits between
  the label and the newline, and a `$`-anchored pattern therefore never matches. The
  reviewer re-ran the identical command against a log where the four steps demonstrably
  *did* run: still 0.
- **Why it matters**: D5 was written to correct an R50 violation (pass count read as
  coverage). Its own supporting evidence was a second, independent R50 instance — a
  command whose output is decoupled from what it claims to measure. The conclusion was
  right by coincidence, not by proof.

**Assessment: ACCEPTED, fixed.** D5's evidence block now records the correction, gives the
ANSI-stripping form, and states plainly that neither the corrected grep nor the 61→69
count is what closes the gap — the direct runs in D7 are.

### F4 [Major] — C3's acceptance criterion was unmet: the audit output was never recorded

- **File**: `docs/archive/review/bump-brace-expansion-override-plan.md` (C3 Acceptance)
  vs. the deviation log
- **Problem**: C3's acceptance reads *"the commands run and their output is recorded in
  the deviation log."* D4 recorded only the *disposition* ("Run manually — T2/T3"); no
  `found 0 vulnerabilities` line, no exit code, no transcript appeared anywhere in D1-D6.
  A reader auditing this PR from its committed paper trail could not find evidence that
  I7 — the invariant the whole PR exists to satisfy — was ever actually run.

**Assessment: ACCEPTED, fixed.** D7 records the full transcript for all four audit scopes
and all four mandatory checks, each exit status read from the command itself with no pipe
in between.

### Testing verification that found no discrepancy

The reviewer re-executed every check the plan and deviation log claim — both audit scopes,
the sub-package audits, the Class A/B/C lockfile enumerations, both disjointness reads,
all three license audits, `eslint`, `vitest`, `next build`, a full `pre-pr` re-run, the
churn diff, and the `Dockerfile` non-touch. All reproduced.

It also reported making the R44 mistake itself on a first pass (piping audit output
through `tail` before reading `$?`, which reads `tail`'s status) and redoing every capture
without a trailing pipe. The orchestrator hit the same class independently: a first
attempt at D7's transcript returned `eslint_exit=2` and a build summary reading "1 routes
… Errors: 1", both artifacts of this environment's output-compressing command proxy
mangling the streams. Re-running with plain file redirection gave exit 0 / zero output for
eslint and the real 243-route build. Recorded in D7 — a compressed exit code is the R44
shape arriving from the tooling rather than from a pipeline the author wrote.

## Adjacent Findings

None. All three experts stayed within scope; no `[Adjacent]` tags were raised this round.

## Quality Warnings

None. Every finding carries a reproducible command and its observed output.

## Recurring Issue Check

### Functionality expert

- R1-R28, R30-R32, R35-R41, R43-R46, R50 — N/A: no source code, UI, tests, migrations, CI config, or runtime artifact in the diff.
- R29 — Checked: every GHSA id and band cited in both the plan and the runbook re-verified against live `gh api` output; no hallucinated citation.
- R33 — N/A: no `.github/workflows/*` file touched.
- R34 — Checked: D2 records the Step 2 `rm -rf` guidance with an explicit rationale; assessed as sound.
- R42 — Checked: Classes A, B and C re-derived from their defining primitives rather than from the plan's tables; all matched.
- R47 — Checked: the runbook correctly describes npm's first-match-by-key-order semantics rather than an assumed specificity rule, and the shipped keys avoid creating an overlapping pair.
- R49 — Checked: C1-C6 each carry an explicit control-class declaration and none overstates what it enforces.
- R51 — Checked: every resolved-version read specifies "from the lockfile, not `npm ls`", with the method note explaining why.
- RS1-RS6, RT1-RT11 — out of scope (other lanes).

### Security expert

- R1-R28, R30-R40, R43-R46, R51 — N/A: config-only diff, no runtime code path, no boundary touched.
- R29 — Checked: all advisory ids, severities, bands and patched versions independently re-fetched; CI job names and `licenses:check*` script names in the runbook's Quick reference verified to exist.
- R41 — **Finding F2**: the class was closed once for the `npm audit` claim (C5) but one instance survived for the adjacent `pre-pr` coverage claim.
- R42 — Checked: Classes A and B plus thirteen Class C rows re-derived from the committed lockfiles and live advisory data; no delta.
- R47 — Checked: adjudication is delegated to `gh api` and npm's resolver, not to a surface-form string read.
- R48 — **Finding F1**: the disjointness check is an informal verifier whose correctness was derived only over this PR's own bound form, not over the general shape a future key could take.
- R49 — Checked: no contract or doc section claims a control stronger than what exists.
- R50 — Checked in the target; see the Testing lane for the instance found in the review artifact.
- RS1-RS3, RS5, RS6 — N/A: no crypto, rate-limit, or injection surface in a JSON config plus markdown diff.
- RS4 — Checked: no personal-identifying data in any added file.

### Testing expert

- R1-R43, R45-R48, R51 — N/A or Checked-clean: config-only diff, no new code path, no new adjudicator, no boundary widened.
- R44 — Checked clean in the target (none of `pre-pr.sh`'s or T1-T13's commands pipe through a status-swallowing filter). Instances were found in the reviewer's own and the orchestrator's methodology and corrected; recorded in D7.
- R49 — Checked: C1-C6's control-class labels still accurately describe the mechanisms post-implementation.
- R50 — **Finding F3**: a fresh instance inside the artifact written to correct an R50 instance.
- RT7 — Re-applied to every row T1-T13, each exercised directly rather than trusting the label. T1, T4, T7-T11, T13 provably fail-capable; T2/T3/T6 remain honestly labelled as non-fix-provers; T12's four sub-checks all verified, including the mandatory read over the full runbook.
- RT10 — N/A for the shipped diff (no new guard). Directly relevant to F3, which is this failure shape in a review artifact rather than in shipped code.
- RT1-RT6, RT8, RT9, RT11 — N/A: no tests, mocks, fixtures, or twins in the diff.

## Environment Verification Report

Phase 1 declared two `Verification environment constraints`.

| ID | Constraint | Classification | Evidence |
|---|---|---|---|
| VC1 | Trivy container scan is CI-only (`pre-pr.sh` does not build the image) | **N/A — no path blocked** | C4 establishes the image surface is untouched: `Dockerfile` is absent from `git diff --name-only`, and `BE_VER=5.0.8` lies outside every band of both advisories, re-derived from the full `gh api` band list rather than from `npm audit`. No manual-test path was deferred. |
| VC2 | npm resolution depends on the npm version; neither local nor CI pins npm (CI pins Node only, via `.nvmrc`, with no `corepack enable`) | **verified-local, with CI as the authoritative re-check** | Local: `npm install` produced a 12-line lockfile diff confined to the two intended packages; `npm ci` reproducibility is delegated to CI per SC3, whose Anti-Deferral cost-justification is recorded in the plan. |

No path is classified `blocked-deferred`, so no Anti-Deferral linkage is required for this
section. The deferrals that do exist (SC3, SC5, SC6, SC7, and D4's parity gaps) each carry
a cost-justification with a named owner in the plan or the deviation log.

## Resolution Status

### F1 [Major] Runbook disjointness check unsound for inclusive upper bounds
- Action: Step 4 now mandates half-open exclusive-upper ranges, states that the
  disjointness check is valid only for that form, includes the two-key counterexample with
  its order-dependent resolutions, and gives the strict-`>` escape hatch.
- Modified file: `docs/security/dependency-cve-response.md` (Step 4)
- Alternatives searched: leaving the check as-is and relying on the fact that this PR's
  keys are all exclusive-upper — rejected, because the runbook's whole purpose is to
  govern keys nobody has written yet.

### F2 [Major] `pre-pr` coverage claim lacked the commit-first caveat
- Action: Step 3 now states that `detect_web_changes()` reads the committed diff, that the
  four web steps are otherwise silently skipped, names `PRE_PR_FORCE_FULL=1`, and gives
  the ANSI-stripped grep for confirming the steps ran.
- Modified file: `docs/security/dependency-cve-response.md` (Step 3)

### F3 [Major] D5's evidence grep can never match
- Action: D5's evidence block rewritten — records the correction, gives the ANSI-stripping
  form, and states that the direct runs in D7 are what close the gap, not the grep and not
  the 61→69 pass count.
- Modified file: `docs/archive/review/bump-brace-expansion-override-deviation.md` (D5)

### F4 [Major] C3's acceptance unmet — audit output not recorded
- Action: D7 added with the full transcript for all four audit scopes and all four
  mandatory checks, each exit status read from the command itself.
- Modified file: `docs/archive/review/bump-brace-expansion-override-deviation.md` (D7)

### Post-fix re-verification
`T12` re-run after the Round-1 edits: (a) `runs the same.*npm audit` → 0, (b)
`Full pre-PR parity check` → 0, (c) `lower bound` → 3 matches, (d) `npm audit` in
`pre-pr.sh` → 0. Corrected forbidden pattern `pre-pr.*(runs the same|parity)` → no match.
