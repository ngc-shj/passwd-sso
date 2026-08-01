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

---

# Code Review round 2

Date: 2026-08-01 · Reviewed: `git diff c3a35369f..HEAD` (commit `9d5aa7337`)

## Changes from Previous Round

Round 1's four Major findings were fixed: runbook Step 4 gained a bound-form rule, Step 3
gained the commit-first caveat, D5's evidence block was corrected, and D7 recorded the
verification transcript.

## Findings — two Major, both convergent

`convergent: functionality+security` on both. Severity floor Major per "Perspective
Convergence as a Severity Signal"; both lanes reached them independently.

### R2-F1 [Major, continuing] — "the form every key in this file already uses" is false

Round 1's fix mandated `>=<floor> <<ceiling>` and asserted every key already used it.
`package.json` ships `brace-expansion@1` and `@2` — bare-major selectors — and the
runbook's own worked example two sentences earlier uses one. Beyond the false claim, the
mandate was the wrong *shape* of rule: it left no procedure for shorthand selectors,
`||` alternations, or the whole-package unbounded form, all of which npm accepts and all
of which the disjointness check would then be applied to blind.

**Assessment: ACCEPTED.** The syntax mandate was replaced with a translation procedure —
a table mapping each selector form to its half-open interval, then a disjointness check
over intervals rather than over selector text.

### R2-F2 [Major, continuing] — Step 3's commit-first rule never reached Step 2's command block

Step 3 said "commit first"; Step 2's fenced block — the part a responder types — still ran
`npm run pre-pr` straight after `npm install`, with the commit mentioned only in prose
*after* the block. Executed top-to-bottom it reproduces exactly the failure D5 records.

**Assessment: ACCEPTED.** `git add` + `git commit` moved inside Step 2's block, ahead of
`npm run pre-pr`, with the reason stated immediately after.

### Testing lane — Round 1 fixes confirmed resolved

The corrected ANSI-stripped grep was verified **bidirectionally falsifiable** against
three real logs: `0` on the run where the steps were skipped, `4` on both runs where they
executed. Every figure in D7's transcript re-ran and reproduced. One Minor: D7 attributed
two distinct anomalies to one cause without demonstrating the mechanism — **ACCEPTED**,
rewritten to record the anomaly as undiagnosed.

---

# Code Review round 3

Date: 2026-08-01 · Reviewed: `git diff 9d5aa7337..HEAD` (commit `0bc8dd32e`)

## Changes from Previous Round

Round 2's two Major findings were fixed: the interval-translation table replaced the
syntax mandate, and the commit moved into Step 2's command block.

## Findings

### R3-F1 [Major, continuing] — the interval table repeats the class one layer down

Both lanes converged again. The Functionality lane found the `>X` row breaks the table's
own algorithm — `pkg@<=1.1.16` and `pkg@>1.1.16` are genuinely disjoint, but the row
displays `(1.1.16, ∞)` and the stated `floor >= previous ceiling` comparison then reports
an overlap. The Security lane ran one npm invocation against a scratch project and found
six accepted selector forms with no row at all: `*`, `""`, exact pins, hyphen ranges,
`~`, and prerelease-tagged bounds — plus `$ref` values on the override's right-hand side,
which the procedure assumes are literal versions.

**Assessment: ACCEPTED — and treated as a mechanism failure, not a missing row.**

Three rounds, three enumerations, three falsifications by a case outside the enumeration.
That accretion is the signal that the class was derived from the wrong primitive. The
primitive is not "which spellings a selector can take" — it is npm's range parser, and
every hand-written table is a second parser standing in for it (R47). The table was
deleted and the predicate handed to `semver.intersects`, the library npm resolves with.
Verified against every form the review found missing, and against both counterexamples
earlier rounds turned on — including `<=1.1.16` vs `>1.1.16`, which the table got
backwards and the interpreter gets right.

### R3-F2 / R3-F3 [Minor] — missing selector forms, and "floor" used for two different things

Both dissolved with the table: there are no rows left to omit, and with the interval
vocabulary gone, "floor" again means only the override's forced version.

## Termination

The class's member-set expanded three times, so per the triangulate convergence rule for
an expanded class, "no findings" is not a sufficient stop condition — the closure artifact
is a **mutation-verified guard wired into the authoritative gate**. At the maintainer's
direction that guard now exists:

`R42 class "override key disjointness": member-set expanded 3× — closed by
mutation-verified gate scripts/checks/check-override-key-disjointness.mjs (red-proven:
injecting brace-expansion@<=1.1.17 beside brace-expansion@1 makes it exit 1; also proven
red on a whole-package key beside a ranged one, and on a nested-scope overlap), wired in
scripts/pre-pr.sh as "Static: override-key-disjointness", with a 15-case committed
self-test at scripts/__tests__/check-override-key-disjointness.test.mjs.`

See deviation-log D9 and D10.

## Resolution Status — rounds 2 and 3

### R2-F1 / R3-F1 [Major] Disjointness guidance falsified three times
- Action: guidance replaced by a gate. `semver.intersects` adjudicates; the hand-written
  table is gone; `semver` promoted from transitive hoist to explicit devDependency so the
  gate does not depend on which copy hoists.
- Modified: `docs/security/dependency-cve-response.md` (Step 4),
  `scripts/checks/check-override-key-disjointness.mjs` (new),
  `scripts/__tests__/check-override-key-disjointness.test.mjs` (new),
  `scripts/pre-pr.sh`, `package.json`, `package-lock.json`
- Alternatives searched: adding the missing rows (rejected — that is "more cases" when
  three rounds have shown the mechanism is wrong); leaving it as documentation (rejected
  by the convergence rule for a ≥2×-expanded class, and by the maintainer).

### R2-F2 [Major] Commit-first rule absent from the command block
- Action: `git add` / `git commit` moved inside Step 2's fenced block ahead of `pre-pr`.
- Modified: `docs/security/dependency-cve-response.md` (Step 2)

### Round-2 Testing [Minor] D7 attributed an undiagnosed anomaly
- Action: rewritten to name both candidate mechanisms and record the cause as not
  established, since the likelier one (an ordinary pipe swallowing the exit status) is the
  one the next reader can act on.
- Modified: `docs/archive/review/bump-brace-expansion-override-deviation.md` (D7)

## Final verification

| check | result |
|---|---|
| `npm audit` (full scope) | exit 0 — found 0 vulnerabilities |
| `npm audit --omit=dev --audit-level=high` | exit 0 — found 0 vulnerabilities |
| `cli` / `extension` audits | exit 0 each |
| `npx eslint .` | exit 0, no output |
| `npx tsc --noEmit` | exit 0, no output |
| `npx vitest run` | exit 0 — **1007 files, 13970 passed, 1 skipped** (was 1006 / 13955; +15 from the new gate's self-test) |
| `npx next build` | exit 0 — compiled successfully, 243/243 static pages |
| `licenses:check:strict` / `:ext:` / `:cli:` | PASSED (strict) |
| `scripts/pre-pr.sh` | all checks passed, with the four web steps confirmed present by an ANSI-stripped step-label count — not by the pass count |
