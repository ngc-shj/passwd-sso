# Coding Deviation Log: stale-override-floors

## D1 — S11's ambient-variable set included two variables that cannot redirect a request

**Plan text (revision 4, S11)**: "The ambient set is `GITHUB_API_URL`,
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`, `NODE_EXTRA_CA_CERTS`, and
`NODE_OPTIONS`."

**What was built**: the set without `GITHUB_API_URL`, `NO_PROXY` or `no_proxy`.

**Why the plan was wrong.** The implementation followed S11 literally and refused
whenever any listed variable was non-empty. Two of them are false-red surfaces:

- **`GITHUB_API_URL` is a GitHub Actions default environment variable, set in every
  workflow run.** A gate that refuses on its presence reds on its first CI run — both
  the PR job and the weekly sweep — for a reason that has nothing to do with the tree.
  That is the "reds intermittently for non-tree reasons" failure the plan's own
  Considerations section names as the pressure that produces a `continue-on-error`.
  It also redirects nothing by itself: it is inert unless code reads it. The invariant
  S11 was really after — *the gate never reads it* — is enforced structurally, by the
  self-test asserting `process.env` appears on exactly one line (the entry point).
- **`NO_PROXY` is a bypass list, not a destination.** Setting it cannot send a request
  anywhere new. Corporate laptops and CI runners set it routinely.

Verified after the correction: the gate exits 0 at the branch tip, exits 0 with
`GITHUB_API_URL=https://api.github.com` set (the real CI condition), and still refuses
`HTTPS_PROXY`. The self-test gained a paired ALLOW case for each removed variable and a
`not.toContain` assertion recording why they are out, so a future re-add reds.

**Anti-Deferral check**: not a deferral — fixed in Phase 2, in both the code and the
plan's S11.

## D2 — `FALLBACK_MANIFESTS` exported from the disjointness gate

**Plan text**: C2 lists three additions to `collectScopes`; the export is not among them.

**What was built**: `FALLBACK_MANIFESTS` in
`scripts/checks/check-override-key-disjointness.mjs` gained `export`.

**Why**: N4 requires the new gate to reuse `discoverManifests` but explicitly *not* to
inherit its silent fallback — a degraded-but-plausible manifest list is correct for the
disjointness predicate and is a refusal for the staleness predicate (P-4, N5).
`discoverManifests` returns that exact array object by reference on the fallback path
and a fresh array otherwise, so reference identity is what makes the two decidable. A
content comparison cannot tell them apart, because today the real `git ls-files` answer
is content-equal to the fallback.

No behaviour change; the existing cases pass unedited.

**Anti-Deferral check**: not a deferral — a one-line visibility change required by N4,
recorded because it is not in the contract text.

## Carried-forward findings from Phase 1

- **R3-CF1** (command-line contract) — **closed in Phase 2.** The gate declares a
  flag/path split with named refusals for an unrecognized flag, an unreadable named
  path, a discovery fallback, and a zero-row walk, per P-4.
- **R3-CF2** (AC-3.3 fixture-server reachability under the origin pin) — **closed in
  Phase 2.** The origin is an explicit `--origin=` argument; the pin's subject is how
  the origin was supplied, so a local fixture server is reachable without an
  environment test-mode. 18 process-level cases run against `http.createServer`.
- **R3-CF3** (O-9's fixture cannot detect an upstream rename) — **closed in Phase 1**
  by correcting the claim; the fixture is the RT1 anchor and selects its element by
  GHSA id, refusing if the lookup fails or the element became withdrawn.
- **R3-CF4** (`not-judged` row and the census arithmetic) — **closed in Phase 2.** The
  walk yields 25 rows (24 pins + 1 scope opener) and queries 18 names (17 pin names +
  the scope-opener parent); a second instrument in the self-test counts the rows
  independently.

## Deferred CI parity gaps

`npm run typecheck`, `npm run licenses:check{,:ext,:cli}:strict` and
`scripts/check-state-mutation-centralization.sh` run in CI and not in
`scripts/pre-pr.sh`. None is reachable by this change (no TypeScript, no new
dependency, no `src/` state). Closing them is `pre-pr.sh`'s subject and the same
operator decision as SC-B. Worst case: a future PR that does touch those surfaces
discovers the failure at push rather than locally. Likelihood: certain eventually, zero
here. Cost to fix: small per gate, but it changes `pre-pr`'s runtime for every
developer.

## D3 — `refactor-phase-verify` fails on unmodified main; not introduced here

The Phase 2-4 CI-parity sweep ran every gate `extract-ci-checks.sh` finds. Twelve of
thirteen pass. `node scripts/refactor-phase-verify.mjs --force` fails, and it fails on a
clean worktree checked out at `origin/main` as well (5/16 of its own scripts pass), so
it is not introduced by this branch.

Two separate things were confounded in the first reading, and both are worth recording:

- The message this branch produced locally was `Branch is stale vs origin/main`, which
  reads like a rebase problem. It is not. The gate compares `origin/main`'s SHA against
  `.refactor-phase-verify-baseline`, a **gitignored, machine-local** file that still held
  `88c8a859e` (an ancestor of today's `origin/main`). In CI the file does not exist, so
  the first run records a baseline and proceeds — the staleness message is a local
  artifact only.
- The real failure underneath is the 5/16 script result, which reproduces on unmodified
  `origin/main`.

**Not a parity gap for this change.** The gate is invoked only by
`.github/workflows/refactor-phase-verify.yml`, whose triggers are `push` to `refactor/**`,
`merge_group`, and `workflow_dispatch`. This branch is `fix/stale-override-floors`, so the
workflow does not run on its PR. `ci.yml` mentions the workflow only in a comment.

**Anti-Deferral check**: pre-existing in an unchanged file, routed rather than dropped.
Worst case: the gate reds in the merge queue, if the repository enables one, for every
PR — independent of this branch. Likelihood: it is already failing, so certain whenever
that trigger fires. Cost to fix: unknown from here; it belongs to the
`split-overcrowded-feature-dirs` initiative that owns the script
(`docs/archive/review/split-overcrowded-feature-dirs-plan.md` §Phase 0), not to a
dependency-override subject. Fixing it here would mix two subjects and would be a guess
at another plan's intent.
