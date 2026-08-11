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

## D4 — Self-R-check findings fixed in Phase 2

The Step 2-5 self-check (three sub-agents, R1–R57 + RS*/RT*) returned two Major findings,
both proven by execution. Per the disposition rule both were fixed here rather than
deferred to Phase 3.

**Major — `NODE_TLS_REJECT_UNAUTHORIZED` was not in the refused ambient set.** Proven
against the gate's own transport: a self-signed certificate for `CN=api.github.com` is
rejected without the variable and accepted with it. An operator or self-hosted runner
with `NODE_TLS_REJECT_UNAUTHORIZED=0` exported — the common "fix the corporate proxy"
reflex — plus name resolution is enough for an interceptor to serve the real canary
payload and an empty list for the other seventeen names, at which point every row is
`clean` and the gate exits 0 forever. No code edit, no workflow edit, nothing in a diff.

The member set was internally inconsistent rather than deliberately narrowed:
`NODE_EXTRA_CA_CERTS`, which appends **one** trusted CA, was refused while the variable
that accepts **every** certificate was not. S12 and the playbook both name TLS as what
stands between the gate and a response-shaping adversary, so the claim was stronger than
the implementation (R49). Added, with a paired deny case.

**Major — `set +o errexit` escaped C7's `set +e` mask clause.** The clause matched the
`+`-cleared flag cluster only (`set +e`, `set +ex`). The long-option spelling disables
errexit identically and was not caught, so a `run: |` block could put it ahead of the
gate and green the job. The same function's `pipefail` predicate already handled `-o`'s
long form, so the two halves of one function disagreed about shell syntax. Added, with
a paired allow case for `set -o errexit`, which is the opposite instruction.

Minor findings also fixed here, each straightforward:

- `first_patched_version` was validated as "null or a string" and then handed to
  `semver.gt`, which throws on a non-version. The throw escaped the comparison guard, so
  the entry landed in **none** of the five outcomes — fail-closed, but as a stack trace
  where a named `STALE` row belonged, contradicting I-3.1. Now rejected at the boundary,
  which is the only place the offending advisory id is still in hand.
- S12's third layer was inert: none of the three invocations passed `--report`, so a
  package the API answered nothing about produced output identical to one with 44
  advisories checked. The weekly sweep now passes it; the verdict is unchanged (P-5).
- The recorded fixture was a verbatim capture including `credits[].user` — 26 real
  GitHub logins, user ids and avatar URLs that no assertion reads. Removed; the fields
  the boundary check and the transform consume are untouched, so the RT1 anchor property
  survives. 75663 → 40284 bytes.
- `expect(exitCodeFor(rows)).toBe(exitCodeFor(rows))` cannot fail. Replaced with the
  property it was reaching for: a stale row exits 1 and the same rows marked clean exit
  0, under both formatters.
- The export-coverage guard counted name occurrences over the whole test source,
  comments included, so naming an untested export twice in a comment cleared it. Now
  counted over code only.
- The queried-set case asserted three things a function returning *only* scope-opener
  parents also satisfies. Set equality against pin names ∪ opener parents added.
- `DEPENDENCY_FIELDS` and `isPlainObject` were byte-identical copies of primitives the
  sibling walker owns. `isPlainObject` is load-bearing in both — it decides whether a key
  opens a nested scope in one and whether a pin is a scope opener in the other, and the
  two must agree by construction, not by having been typed twice. Both are now imported.

## D5 — AC-5.3 cannot be satisfied before merge

AC-5.3 requires the scheduled workflow to be dispatched and the run **observed** green.
`workflow_dispatch` requires the workflow to exist on the default branch, so
`gh workflow run override-floor-staleness.yml` returns 404 until this merges. Phase 1
discharged R32 and R50 by pointing at AC-5.3, so those are currently discharged by an
unmet criterion.

The gate itself is exercised — `ci.yml`'s PR job runs the identical command on every
push to this branch. What is not yet exercised is the new workflow file's own
`schedule` / `permissions` / checkout wiring.

**Anti-Deferral check**: acceptable risk, quantified. Worst case: the weekly workflow is
malformed in a way no static check catches and the sweep silently never runs — the
detection half of the control, not the blocking half. Likelihood: low; the file is
SHA-pin checked, supply-chain checked, and step-for-step identical to the PR job that
does run. Cost to fix: one `gh workflow run` after merge. **Post-merge action**: dispatch
it and confirm a green run before closing this work.

## D6 — Mutation-loop record

AC-4.3 requires the loop to be run with the pairings and the observed failure mode
recorded. It was run twice, independently:

- The implementing agent ran 19 single mutations on a scratchpad clone; every one red
  ≥1 named case, 0 survived, 118 assertion-mode reds and 9 throw-mode. The
  `startsWith`-vs-exact mutation of the same-package filter red only the `lodash` half
  and left `lodash-es` green — the discriminating split the plan predicted.
- The Step 2-5 testing self-check re-ran 16 mutations on its own `git clone`, plus 6 on
  the widened supply-chain check, and reproduced the result independently.

One mutation cannot satisfy O-10's "the allow half stays passing", and it is the
comma-band one: deleting the normalizer throws on *every* comma band, so both halves of
the O-6 pair red. That is the trap's own mechanism. What the record carries instead is
the **mode** — the allow unit case reds with `TypeError: Invalid comparator: >=4.0.0,`
and the allow manifest case reds with the named `UNDECIDABLE_COMPARISON_THREW`, i.e. the
gate converts the throw into a refusal rather than swallowing it, which is what I-3.2
asks for. Recorded rather than replaced with a weaker mutation that would have left the
allow half green.
