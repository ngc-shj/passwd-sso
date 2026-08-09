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
