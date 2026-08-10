# Code Review: stale-override-floors
Date: 2026-08-09 / 2026-08-10
Review round: 1

## Changes from Previous Round

Initial code review. Phase 2 Step 2-5 had already run a focused R1–R57 (+ RS*/RT*)
self-check and fixed two Major and seven Minor findings, so Round 1 was scoped as
incremental verification: novel issues and any rule miss the self-check overlooked.

Local LLM pre-screening (`pre-review.sh code`) returned `No issues found.` The
per-expert seed generator returned `No findings` for functionality and security and
timed out on testing (0-byte file), so the testing expert fell back to full-diff
review. All three seeds were treated as weak evidence, per the seed trust advisory —
correctly, as the round shows.

## Result

**1 Critical, 10 Major, 14 Minor.** Every Major was proven by execution, not argued.

### The headline

The gate this branch adds **caught its own tree, one day after being written**.
`GHSA-5p4m-2wfm-xmqj` published after the branch tip and left both `js-yaml` override
floors stale; `node_modules/js-yaml` resolved 4.3.0, inside the live band
`>= 4.0.0, < 4.3.1`. `js-yaml` is a devDependency, so all three audit jobs — which run
`--omit=dev` — saw nothing. Only the new gate did. That is the plan's user-scenario 1,
arriving unprompted and unrehearsed.

Two experts found it independently. Both also concluded the selector must move with
the pin, not just the pin: the keys are the ranged form, where the convention in this
block is that the selector's upper bound equals the pinned floor, so raising `^4.3.0`
to `^4.3.1` alone would stop the key selecting a 4.3.0 edge and it would resolve
unoverridden — the silent-green shape this branch exists to close, one dimension over.

### Convergence

| Cluster | Experts | Disposition |
|---|---|---|
| Two `js-yaml` floors stale at HEAD; 4.3.0 live in the lockfile; the branch's own gate exits 1 | Func (Critical) / Sec (Major) | **Fixed** — both keys' selector and pin raised; lockfile 4.3.1 |
| `nanoid` 3.3.16 (production via `postcss`, and again in `cli/`) in a HIGH band with no override key; `npm audit --omit=dev --audit-level=high` exits 1 | Func | **Fixed** — `^3.3.17` in both trees. Pre-existing on main; a transitive dependency OF an overridden package, a category SC-D does not name |
| The gate trusts any `git ls-files` answer; ambient git state silently shrinks coverage and it still reports PASS | Sec (Major) | **Fixed** — subset assertion against the on-disk baseline |
| A readable manifest with no `overrides` yields no row, no refusal, no manifest count | Func (Major) | **Fixed** — named path refuses, discovered path is a visible `not-judged` row |
| The exit-mask detector enumerates spellings, not the class — 5 real masks evade | Sec (Major) | **Fixed** — polarity inverted to a simple-top-level-command allowlist for invocations; spelling rules kept as a second layer |
| The ambient-variable deny cases are parameterised over the array under test — 5 of 9 members deletable in silence | Test (Major) | **Fixed** — literal set equality alongside the `it.each` |
| Two `checkResponseShape` clauses unreached, one of them Phase 2's own fix | Test (Major) | **Fixed** |
| The token path never executed (`Bearer` → `Basic` survives) | Test (Major) | **Fixed** |
| `redirect: "error"` has no case | Test (Major) | **Fixed** |
| The `process.env` read-count guard's defect assertion applies no predicate | Test (Major) | **Fixed** |
| I-5.3 (no paths-filter) asserted only in comments | Test (Major) | **Fixed** — parsed-job assertion |

### Minor findings, all fixed

`parseArgs` numeric validation accepting `""`/hex/exponential; a scope opener's failed
query invisible outside `--report`; `[object Object]` in one refusal; the `NODE_OPTIONS`
rationale overstated in three places; `sanitizeLine`'s `::` refusal structurally
unreachable on every path carrying advisory text; the credential attached to every
origin including a plaintext fixture server; `normalizeBand`'s `g` flag unexercised; the
output cap asserted three times looser than it is set; a case titled "both subjects"
asserting one; the second instrument over-counting an object-valued `"."`; a
spawned-child kill timer that can never fire before vitest gives up; two misleading
labels; and five drifted line-number citations.

## Orchestrator verification

Every Major was reproduced before being fixed, and the two headline items were
re-derived independently:

- The gate at HEAD exited 1 naming both `js-yaml` keys and `GHSA-5p4m-2wfm-xmqj`.
- `npm audit --omit=dev --audit-level=high` exited non-zero on `nanoid`, and equally so
  on unmodified `main` — routed as pre-existing-in-changed-file, not blamed on the branch.
- After the fix: full-scope `npm audit` is zero in all three trees, the production-scope
  command CI runs exits 0, the gate exits 0 (27 entries, 19 packages), and the
  disjointness gate — which must be re-run because the keys changed — exits 0.

One fix was found by a guard this work had strengthened one round earlier: the O-3
export-coverage check, changed in Phase 2 to count code rather than comments, caught
`sanitizeUntrusted` shipping without a case.

`pre-pr` at the fix commit: **71 steps passed, exit 0**, with Lint / Typecheck / Test /
Build all confirmed to have actually run rather than being skipped by the diff filter.

## Environment Verification Report

| Phase-1 constraint | Path | Status |
|---|---|---|
| VE-1 (`pre-pr` does no network I/O) | probe-gated local step; token-absent run prints the skip line and stays green | `verified-local` — `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` with both token vars unset |
| VE-2 (advisory DB is a moving input) | self-tests inject advisory data; one recorded response committed | `verified-local` — 217 cases, no network |
| VE-3 (rate limits) | every acceptance step reaching the API refuses without a token | `verified-local` — measured 19 queries per run |
| VE-4 (macOS host, no GNU `timeout`) | bounded runs resolve `timeout`/`gtimeout` and refuse if neither exists | `verified-local` on Linux; the macOS path is `blocked-deferred` — the verification host is unreachable from this session, and the constraint was declared in Phase 1 |
| VE-5 (Trivy unreachable) | not exercised, deliberately | `blocked-deferred` — declared in Phase 1; verifying by Trivy would go green regardless |
| AC-5.3 (observe the scheduled workflow green) | `workflow_dispatch` 404s until the workflow is on the default branch | `blocked-deferred` — deviation log **D5**, with a named post-merge action |

## Resolution Status

### Critical — two js-yaml floors stale at HEAD
- Action: raised both keys' selector and pin (`>=3.0.0 <3.15.1`:`^3.15.1`,
  `>=4.0.0 <4.3.1`:`^4.3.1`); regenerated the root lockfile.
- Modified: `package.json:146-147`, `package-lock.json`
- Verified: gate exit 0; disjointness exit 0 (keys changed, so re-run rather than assumed).

### Major — nanoid in a HIGH band, no override key, both trees
- Action: `"nanoid": "^3.3.17"` in the root and `cli/` overrides; surgical lockfile bumps.
- Modified: `package.json`, `cli/package.json`, `package-lock.json`, `cli/package-lock.json`
- Note: regenerating `cli/package-lock.json` wholesale also produced a pre-existing
  version drift and `dev` → `devOptional` churn from a newer local npm. Only the nanoid
  entry was applied, to keep the commit to one subject.

### Major ×9 — the coverage, masking-class and test-blind-spot findings
- Action: as summarised in the convergence table; each fix red-proven by re-applying the
  mutation that previously survived and confirming it now reds a named case.
- Modified: `scripts/checks/check-override-floor-staleness.mjs`,
  `scripts/checks/check-workflow-supply-chain.mjs`,
  `scripts/__tests__/check-override-floor-staleness.test.mjs`,
  `scripts/__tests__/check-workflow-supply-chain.test.mjs`

### Process note — mutation technique
The red-proof for `sanitizeUntrusted` was run by copying the tracked gate aside,
mutating the tracked file, and restoring it — rather than running the suite against a
throwaway copy, which is the rule this project holds. The restore was verified
(both sanitizers present, no residue, gate green, 217 cases passing), but the technique
was wrong and is recorded rather than omitted.

---

# Round 2

## Changes from Previous Round

The round-1 fixes: two `js-yaml` floors and `nanoid` raised; a `git ls-files`
coverage subset refusal; a named-vs-discovered split for an override-free manifest;
the exit-mask detector's polarity inverted from a spelling denylist to a
"simple top-level command" allowlist; and six test blind spots closed.

## Result

**1 Critical, 13 Major, 7 Minor.** The round's finding is that *the fixes introduced
new defects* — which is what an incremental round exists to catch.

### The fix that had to be reversed

Round 1's headline was the polarity inversion in `check-workflow-supply-chain.mjs`.
Round 2 measured it to be **wrong in both directions**:

- **Too loose** — seven constructs still masked the exit status unseen: an `if`
  spanning lines, a function body, a heredoc, `eval`, a name arriving through a
  variable, a backgrounded group, and a lowercase `err` trap (bash reads signal names
  case-insensitively; the rule enumerated one case).
- **Too tight** — five shapes *measured to exit 1 under `bash -e`* were rejected:
  `cd x && verifier`, `timeout N verifier`, `verifier; echo`, `env K=V verifier`, and
  a pipe under `set -o pipefail` that the rule twenty lines above deliberately
  exempts, so one function decided the same predicate two ways. It also red a step
  whose `name:` merely described the verifier.
- **Untested** — all four of its exports had zero test references. Deleting the whole
  mechanism left the suite green.

Two rounds had now tried to out-regex bash's grammar. **The user's call was to make
the claim match the implementation**, so the allowlist was removed and C7 narrowed to
what a spelling rule can hold, with the residual stated in the file: multi-line
constructs, `eval` and variable indirection are not caught, and CODEOWNERS on
`/.github/workflows/` remains the primary control — which the file's header had
declared before any of this began.

Two rules were *added*, because both are regex-decidable and both were holes the
allowlist never covered: a non-`bash`/`sh` `shell:` (which removes the `-e` every
other rule assumes — `shell: bash {0}` converted a whole file's verifiers to theatre
while the gate reported PASS), and an ambient-input `env:` key on a verifier-running
workflow (the only place a `NODE_OPTIONS` loader is decidable at all, since the loader
runs before the gate's first line and can delete the variable it would be caught by).

### Two fail-closed guards the round-1 fixes had disarmed

| | after round 1 | after round 2 |
|---|---|---|
| a tree with zero override entries | `gate passed (1 override entry/entries)`, exit 0 | `REFUSED_EMPTY_WALK` |
| run from `cli/` | 3 of 27 entries walked, exit 0 | `REFUSED_NOT_REPOSITORY_ROOT` |

The first is R43 in its plainest form: making an override-free manifest *visible* gave
it a row, and `REFUSED_EMPTY_WALK` counted rows. The second is the cwd half of the
coverage finding — `git ls-files` and `existsSync` both resolve against the working
directory, so subject and baseline shrank together and the subset assertion proved
nothing. Both were reproduced before being fixed.

### Other fixes

The credential-scoping, sanitization and `parseArgs` fixes from round 1 were verified
correct. Closed this round: `sanitizeLine`'s `::` anchor tested the untrimmed line
while GitHub's runner calls `TrimStart()` first, so it could not fire on any line the
gate emits; two fragments the sanitization class fix missed (`advisory.severity`,
the fetch-failure `detail`); the `not-judged` note sat below the `code !== 0` early
return, so it was dropped on exactly the runs an operator reads most closely; and the
test gaps for three round-1 behaviours that survived deletion, the non-discriminating
manifest-count fixture, and `CANARY_COMPARISON_THREW`.

## Two defects the orchestrator introduced while fixing, recorded rather than hidden

1. The first `REFUSED_EMPTY_WALK` fix keyed on a `refusal` string being present. A
   *discovered* override-free row carries one as its visible note, so the guard
   suppressed itself — and, in the other direction, briefly shadowed the more specific
   `REFUSED_MANIFEST_UNREADABLE` and `REFUSED_MANIFEST_WITHOUT_OVERRIDES`. It now keys
   on the outcome.
2. An edit wrote **raw control bytes** (NUL, BEL) into the test source where escape
   sequences were intended. A file carrying a NUL reads as binary to `ripgrep` and
   `grep` — which is what made an audit earlier in this work report eleven false gaps.
   Replaced with escapes.

One check was corrected rather than worked around: the swallowed-comparison forbidden
pattern was applied to the whole file and matched `repositoryRoot`'s `catch`, which
returns null so the caller can emit a named refusal. The comparison it guards lives in
the pure core, so that is where the pattern now looks.

## Resolution Status — Round 2

All 1 Critical and 13 Major are resolved. Of the 7 Minor, five are resolved and two
are carried as stated residuals rather than fixed:

### Residual 1 — the allowlist's coverage, deliberately not restored
- **Anti-Deferral check**: acceptable risk, quantified.
- **Worst case**: a workflow masks a verifier's exit status with a multi-line
  construct, an `eval`, or variable indirection, and this gate does not see it.
- **Likelihood**: low. It requires editing a CODEOWNERS-gated workflow, which is the
  primary control and is unchanged.
- **Cost to fix**: a real shell parser, i.e. a new dependency in a password manager's
  supply chain for a CI gate — the decision the user weighed and declined.
- **Recorded where it will be read**: the file's own header, contract C7, and the
  playbook.

### Residual 2 — `--report`'s per-package counts are emitted only by the weekly sweep
- **Anti-Deferral check**: acceptable risk, quantified.
- **Worst case**: on a PR run, a package the API answered nothing about is
  indistinguishable from one with 44 advisories checked.
- **Likelihood**: certain for that one signal; the canary and the per-package
  integrity rule still run on every invocation, so a dead channel is still caught.
- **Cost to fix**: adding `--report` to the PR job trades a quiet log for a noisy one
  on every pull request.
