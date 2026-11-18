# Code Review: prod-audit-expiring-suppression
Date: 2026-11-18
Review round: 3

## Changes from Previous Round
Round 3 reviewed the round-2 fixes (`a5184a840..fc5d96e22`). N1/S4, T4 and T5 were
confirmed resolved. The T6 comment-line skip was found to fail open (S5, Major,
converging with testing's A1) and was reverted rather than refined. Five further Minor
findings were fixed: F7/S6, which converge; N-T7, raised as Major by testing and pinned
as a regression; N-T8; and N-T9. F8 and A2 were accepted with justification. See
"Round 3 findings" below.

Round 2 reviewed the round-1 fixes (`3fd811f5f..a5184a840`). Every round-1 finding was
confirmed resolved. There were four new Minor findings: N1 and S4, which converge, plus
T4, T5 and T6. They are listed under "Round 2 findings" below.

Round 1: initial review. No plan or deviation log: the branch is a Phase-3-only review of an
owner-approved policy change. GHSA-fc5q-39xc-vjpf (picomatch ReDoS, every release
through 4.0.7, no fixed version) reddened `Audit: App dependencies` — and with it the
required `CI result` check — on every app PR, and the production audit step had no
suppression path by design. The production step now runs
`check-npm-audit.mjs --omit-dev`, which honours only `scope: "production"` entries.
Ollama was unavailable, so there was no pre-screen and no seed; all three experts did a
full-diff review.

## Functionality Findings
- **F1 Minor** — `npm-audit-suppressions.json` / `vulnerability-triage.md`: npm reports
  every copy of a package under one key. A `"production"` entry therefore also silences
  the package's dev-tree copies on the whole-tree run, but nothing said so and the reason
  argued only the production copies.
- **F2 Minor** — `dependency-cve-response.md` Step 3: "CI's gate is production-scope
  only" contradicted the block under it, which now lists the whole-tree step.
- **F3 Minor** — `dependency-cve-response.md` Steps 1 and 2: the `npm audit --omit=dev`
  "confirm clean" commands can never come back clean while a suppressed advisory exists.
  Also, `vulnerability-triage.md`'s "npm audit" section misstated what CI runs. That
  inaccuracy predates this branch, and the file is changed by it.
- **F4 Minor** — `check-npm-audit.mjs` stale-entry message: on the production run it said
  "delete it". When the advisory has only left the production tree, that is the wrong
  fix; the entry should be re-scoped to `"dev"`.

## Security Findings
- **S1 Minor (R29)** — the suppression reason said next's vendored
  `dist/compiled/picomatch` was unused because `next.config.ts` sets no image patterns.
  Next does fill in a default `images.localPatterns = [{ pathname: '**' }]`
  (`next/dist/server/config.js`), which is embedded in `.next/standalone/server.js`, and
  `match-local-pattern.js` runs `makeRe('**')` on every `/_next/image` request. The
  conclusion holds — the pattern is the constant `**`, and a request supplies only the
  string being matched — but the stated reason was false.
- **S2 Minor (R51)** — a production entry matched on `(GHSA, package)`. A future
  dependency that pulls the package onto a request-time path would be silenced, until
  the entry expired, without anyone reviewing the new path.
- **S3 Minor [Adjacent]** — same as F2.

## Testing Findings
- **T1 Minor (RT10)** — no synthetic allow test showed that the whole-tree run honours a
  production-scope entry. Only the committed, expiring entry covered it; a mutation that
  filtered the whole-tree run to dev entries stayed green once that entry was emptied.
- **T2 Minor (question)** — nothing pinned `--omit-dev` on ci.yml's production step. If
  the flag were dropped, that step would become a second whole-tree run that honours dev
  entries.
- **T3 Minor [Adjacent]** — `check-workflow-supply-chain.mjs` did not count the
  vulnerability audits as verifiers, so masking their exit status was not caught.

## Adjacent Findings
- F5 (functionality, testing scope): the committed-suppression self-test uses the real
  clock, so expiry reds the general vitest job as well as audit-app. Both testers judged
  this intended, because it fails loudly on the same day as the live gate.
- S3 = F2. T3 is recorded above.

## Quality Warnings
None. Every finding cited a file and the evidence for it, and each was reproduced before
it was fixed.

## Recurring Issue Check
### Functionality expert
- R1 N/A — no shared utility reimplemented.
- R2 OK — `SCOPES` is defined once.
- R3 F3 — runbook commands not propagated; ci.yml, pre-pr.sh, the other workflows and the
  docs were checked.
- R4–R15 N/A.
- R16 OK — CI and local runs use the same script.
- R17–R28 N/A.
- R29 F2, F3 — the reason's claims were otherwise verified.
- R30–R32 N/A.
- R33 OK — the ext/cli audits are unchanged by design.
- R34 F3 covers the pre-existing doc inaccuracy.
- R35 N/A.
- R36 Reviewed — the suppression has an expiry, a cap, a stale check and owner approval;
  F1 covers the dev half.
- R37–R40 N/A.
- R41 OK — the `--omit=dev` argv is red-proven with a fake npm.
- R42 OK — npm audit's JSON shape was checked against real output.
- R43 N/A.
- R44 OK — both steps run unpiped.
- R45–R47 N/A.
- R48 OK — one adjudicator.
- R49 OK.
- R50 OK — both modes were run live.
- R51–R57 N/A.

### Security expert
- R1 N/A.
- R2 OK.
- R3 OK — ext/CLI are deliberately plain.
- R4–R15 N/A.
- R16 OK.
- R17–R28 N/A.
- R29 S1.
- R30–R32 N/A.
- R33 OK — npm audit appears in ci.yml (ext, cli) unsuppressed by design;
  dependency-signatures.yml and release.yml run only `npm audit signatures`.
- R34 S3.
- R35 N/A.
- R36 OK — no upstream fix; the suppression is scoped, expiring and justified.
- R37–R41 N/A.
- R42 OK — every picomatch copy was enumerated against lockfile `dev` flags and audit
  `nodes`.
- R43 N/A.
- R44 OK.
- R45–R48 N/A.
- R49 OK — the dev-cannot-silence-production claim holds in the code; see S2 for the
  path-level argument.
- R50 OK.
- R51 S2.
- R52 OK — the script's parse, validation and match logic were re-audited.
- R53–R57 N/A.
- RS1 N/A.
- RS2 N/A.
- RS3 OK — fields validated, scope whitelisted.
- RS4 OK.
- RS5 N/A.
- RS6 N/A.

### Testing expert
- R1–R28 N/A.
- R29 OK.
- R30–R32 N/A.
- R33 OK.
- R34–R35 N/A.
- R36 OK.
- R37–R43 N/A.
- R44 OK.
- R45–R49 N/A.
- R50 OK — the scratch baseline was green before any mutation.
- R51–R57 N/A.
- RT1 OK — the fake npm records the real argv.
- RT2 OK.
- RT3 N/A.
- RT4 N/A.
- RT5 OK — the production spawn path is reached.
- RT6 N/A.
- RT7 OK.
- RT8 OK.
- RT9 N/A.
- RT10 T1.
- RT11 OK — a per-test `mkdtemp` directory is removed in `afterEach`.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 (no Phase 1). The live gates were
`verified-local`: `node scripts/checks/check-npm-audit.mjs --omit-dev` and
`node scripts/checks/check-npm-audit.mjs` both exit 0 against the registry. The
standalone-output claims were verified against `.next/standalone` from a local
`next build`.

## Resolution Status
### F1 Minor — production entry silently covers dev-tree copies
- Action: documented in `vulnerability-triage.md` that a `"production"` entry also
  covers dev-tree copies on the whole-tree step and must justify them; the picomatch
  reason now names the dev consumers (vite, vitest, tinyglobby, micromatch via
  patch-package) and why they do not apply. The code is unchanged, because the audit
  JSON cannot split one package key by tree.
- Modified files: `docs/security/vulnerability-triage.md`,
  `scripts/checks/npm-audit-suppressions.json`.

### F2 / S3 Minor — "production-scope only" sentence
- Action: replaced with "CI's audit-app job runs both a production and a whole-tree
  step".
- Modified file: `docs/security/dependency-cve-response.md` (Step 3).

### F3 Minor — runbook "confirm clean" commands
- Action: Steps 1 and 2 now run `check-npm-audit.mjs` (`--omit-dev`, then whole tree),
  with the plain command kept for extension/ and cli/; the "npm audit" section of
  `vulnerability-triage.md` now states what each workspace's CI step runs.
- Modified files: `docs/security/dependency-cve-response.md`,
  `docs/security/vulnerability-triage.md`.

### F4 Minor — stale-entry remedy on the production run
- Action: on `--omit-dev` the message now reads "matches no advisory in the production
  tree — delete it, or change its scope to \"dev\" if the whole tree still has it".
  The whole-tree wording is pinned separately.
- Modified file: `scripts/checks/check-npm-audit.mjs` (stale-entry loop in `main`).
- Red-proof: restoring the old message reddens "fails a production-scope suppression
  that matches no current advisory".

### S1 Minor — false statement in the suppression reason
- Action: the reason now states that Next's default `localPatterns` `**` is the only
  pattern its vendored copy compiles, and that a request supplies only the string
  matched against it.
- Modified file: `scripts/checks/npm-audit-suppressions.json`.

### S2 Minor — production entry bound to a package name, not reviewed paths
- Action: a `"production"` entry must list `nodes` (non-empty, no duplicates; `nodes` on
  a `"dev"` entry is refused). On the production run, the advisory's reported nodes must
  equal that set: an unreviewed node fails, a reviewed node that is gone fails, and a
  report without `nodes` fails closed. Order does not matter, and the whole-tree run does
  not compare nodes. The committed picomatch entry lists the three paths that
  `npm audit --omit=dev` reports today.
- Modified files: `scripts/checks/check-npm-audit.mjs` (`isNodeList`, `nodeErrors`,
  validation in `loadSuppressions`, match in `main`),
  `scripts/checks/npm-audit-suppressions.json`, `docs/security/vulnerability-triage.md`.
- Red-proof (one mutation per clause, each reddening its own test):
  - dropping the node check → "fails a reported node that was not reviewed";
  - dropping the extra-node half → the same test;
  - dropping the vanished-node half → "fails a reviewed node that is no longer installed";
  - dropping the missing-field guard → "fails closed when npm audit reports no nodes to
    compare";
  - dropping the `nodes` requirement → "refuses a suppression with a production scope
    without nodes".
- Allow side: "passes when the reported nodes equal the reviewed nodes in any order".

### T1 Minor — whole-tree allow case for a production entry
- Action: added "honours a production-scope suppression on the whole-tree run, without
  comparing nodes". Its report includes an extra dev-tree node, so it also pins that the
  whole-tree run does not compare nodes.
- Red-proof: filtering the whole-tree entries to `"dev"` reddens it.

### T2 Minor — ci.yml flag not pinned
- Action: added "is wired into CI's app audit job for both the production and the whole
  tree", which asserts both `run:` lines in `.github/workflows/ci.yml`.
- Red-proof: removing `--omit-dev` from ci.yml reddens it.

### T3 Minor [Adjacent] — audits not counted as supply-chain verifiers
- Action: `check-workflow-supply-chain.mjs` now treats `check-npm-audit` and
  `npm audit` as verifiers, both per line and for the workflow-level
  `continue-on-error` ban. The live run over every workflow still passes.
- Tests: `|| true` is flagged and an unmasked run is not flagged, for each of the two
  commands; `continue-on-error` is flagged on a workflow whose only verifier is the app
  gate.
- Red-proof: reverting the regex reddens "flags || true on the app audit gate".

### F5 [Adjacent] — real clock in the committed-suppression self-test
- Accepted as designed: expiry reds vitest on the same day as the live gate, which is
  the loud failure the expiry exists to produce.
- Anti-Deferral check:
  - Worst case: every PR's vitest job goes red on 2026-12-19 until the entry is renewed
    or removed, with the cause printed in the assertion message.
  - Likelihood: certain if nobody acts before expiry, and that is the intent.
  - Cost to fix: none needed.

## Round 2 findings
- **N1 / S4 Minor (R29, R51 residual; flagged by two experts)** — `@rollup/plugin-commonjs`
  → `fdir@6.5.0` resolves the dev-flagged top-level `node_modules/picomatch` (2.3.2, an
  optional peer) and loads it at build time. The reason did not name fdir. The
  production step cannot see that copy, and the whole-tree step silenced it without
  comparing nodes, so the reason had already drifted from the tree unnoticed.
- **T4 Minor (RT10)** — the widened workflow-level `runsVerifier` had no deny case for a
  workflow whose only verifier is a plain `npm audit`, and no allow case for a
  comment-only mention. Two mutations survived.
- **T5 Minor** — the `nodes` element check (non-string or empty-string element) was
  unpinned at `a5184a840`.
- **T6 Minor [Adjacent]** — the per-line verifier checks scanned YAML comment lines. The
  bare `npm\s+audit\b` alternative made a comment such as `` `npm audit` output | head ``
  a false "unprotected pipe".

## Round 2 Resolution Status
### N1 / S4 — dev-tree copies reviewed by path too
- Action: a `"production"` entry may list `devNodes`, the extra install paths only the
  whole tree reports. On the whole-tree run, a production entry's reported nodes must now
  equal `nodes` ∪ `devNodes`. `devNodes` must be a non-empty list of distinct paths,
  disjoint from `nodes`, and is refused on a `"dev"` entry. The production run ignores
  it. The picomatch entry lists the four whole-tree paths, and its reason now names fdir
  (corrected in round 3: a dependency of `@rollup/plugin-commonjs` that
  takes picomatch as an optional peer) beside micromatch. `vulnerability-triage.md`
  documents `devNodes`.
- Modified files: `scripts/checks/check-npm-audit.mjs` (`nodeErrors`, validation in
  `loadSuppressions`, match in `main`), `scripts/checks/npm-audit-suppressions.json`,
  `docs/security/vulnerability-triage.md`.
- Red-proof: one mutation per clause, each reddening its own test:
  - devNodes ignored → "passes when the reported nodes equal nodes plus devNodes";
  - vanished half → "fails a reviewed devNodes path that is no longer installed";
  - overlap rule → "a path in both nodes and devNodes";
  - empty rule → "empty devNodes";
  - dev-entry rule → "devNodes on a dev entry".
- Allow side: "passes when the reported nodes equal nodes plus devNodes" (listed out of
  order); "ignores devNodes on the production run"; "does not compare nodes for a
  dev-scope suppression".

### T4 — allow/deny pair for the widened workflow-level check
- Action: added a deny case (plain `npm audit` with `continue-on-error: true` is flagged)
  and an allow case (a comment that only mentions the audits, with `continue-on-error`
  on an unrelated `npm ci`, gives `[]`).
- Red-proof: dropping `npm\s+audit\b` from `runsVerifier` reddens the deny case;
  matching against raw content instead of run commands reddens the allow case.

### T5 — element check pinned
- Action: added refusal rows for an empty-string node and a non-string node.
- Red-proof: replacing the element check with `true` reddens both rows.

### T6 — lone comment lines skipped in per-line checks (reverted in round 3, see S5)
- Action: a logical line that is a single raw line starting with `#` is skipped by the
  mask and pipe rules. A comment ending in `\` that the joiner merged with the next line
  is NOT skipped, because YAML does not continue a comment, so that next line is a real
  step.
- Modified file: `scripts/checks/check-workflow-supply-chain.mjs` (logical-line
  builder, and the per-line loop in `findMaskedVerifierViolations`).
- Tests: "does NOT flag a comment line that mentions npm audit next to a pipe" (allow);
  "still checks a step that a backslash-ended comment would join onto" (deny).
- Red-proof: removing the skip reddens the allow case; dropping the unjoined-only
  condition reddens the deny case.
- The live run over every workflow passes.

## Round 3 findings
- **S5 Major (R43; testing A1 converges)** — the T6 skip decided "comment line" with a
  regex (`/^\s*#/` on an unjoined line). A line starting with `#` is executable text on
  a continuation line of a multi-line quoted scalar (`run: "echo '` / `#' && npm audit
  || true"`) or of a block whose header `blockMatch` does not recognise (`run: &r |`).
  `a5184a840` flagged those masks; `fc5d96e22` passed them.
- **F7 / S6 Minor (R29; two experts)** — the reason called fdir "an optional peer of
  @rollup/plugin-commonjs". In fact fdir is a regular dependency of
  @rollup/plugin-commonjs (and of tinyglobby), and picomatch is fdir's optional peer
  (`^3 || ^4`, unsatisfied). micromatch also arrives through fast-glob from
  `@next/eslint-plugin-next`, at lint time.
- **F8 Minor** — comment text still counts as a verifier line in three shapes: a
  trailing step comment, a comment on a block header, and a full-line shell comment
  inside a block. Each over-blocks, failing loudly.
- **N-T7 (raised as Major)** — no deny case pinned that a masked step with a trailing
  `# comment` is still flagged. The mutation `/#/` as the comment test survived.
- **N-T8 Minor** — `devNodes` element and distinctness validation was unpinned.
- **N-T9 Minor** — the production-run label in the node messages was pinned only by a
  prefix match.
- **A2 [Adjacent] Minor** — a backslash-joined comment-plus-step line reports the
  comment's line number.

## Round 3 Resolution Status
### S5 — comment-line skip reverted
- Action: removed the skip, so the per-line mask and pipe rules are back to their
  `a5184a840` logic. The gate's comment now records why: comment text is scanned on
  purpose; telling a YAML comment from a `#` inside a multi-line scalar needs a YAML
  parser, and the regex skip exempted executable text. The resulting over-block (T6, F8)
  fails loudly and is fixed by rewording the comment.
- Alternatives searched (cross-perspective protocol): a parser-backed skip (js-yaml
  deep-equality with the line removed) would keep both properties, but it grows this
  spelling-rule gate a YAML-semantics layer — the accretion its own header warns
  against — to remove a false positive no current workflow produces. Security keeps
  precedence: the narrower, fail-closed behaviour stays.
- Modified file: `scripts/checks/check-workflow-supply-chain.mjs` (logical-line
  builder, per-line loop in `findMaskedVerifierViolations`, comment above
  `verifierLineRe`).
- Tests:
  - deny: a masked audit on a `#`-led continuation line of a double-quoted scalar, of a
    single-quoted scalar, and of an anchored block scalar; an unprotected pipe in the
    quoted-scalar shape;
  - over-block pinned: a comment naming `npm audit` beside a pipe is flagged;
  - kept: the backslash-joined deny case.
- Red-proof: against `fc5d96e22`'s gate, all five new cases red.

### F7 / S6 — reason wording
- Action: the reason now says fdir is a dependency of @rollup/plugin-commonjs and
  tinyglobby that takes picomatch as an optional peer (`^3 || ^4`, unsatisfied) yet
  requires it at load; plugin-commonjs globs through it only `dynamicRequireTargets`,
  and tinyglobby passes it no patterns. micromatch arrives via patch-package and, at lint
  time, fast-glob from `@next/eslint-plugin-next`. The round-2 resolution text above is
  corrected to match.
- Modified file: `scripts/checks/npm-audit-suppressions.json`.

### F8 — remaining comment shapes over-block
- Accepted, by the same decision as S5: removing them needs the parser the S5 resolution
  declined.
- Anti-Deferral check:
  - Worst case: a future workflow comment that names `npm audit` beside `|` or
    `|| true` reds the static-checks job, with a message naming the line.
  - Likelihood: low — no current workflow does this.
  - Cost to fix when it happens: reword one comment, as the gate comment says.
  - The failure direction is closed, never open.

### N-T7 — trailing-comment mask pinned
- Action: added "flags a masked audit step that carries a trailing comment".
- Red-proof: a `/#/` line skip reddens it (together with the S5 cases).

### N-T8 — devNodes element/distinctness pinned
- Action: added refusal rows for a duplicated, an empty-string and a non-string
  `devNodes` path.
- Red-proof: weakening the validator to "non-empty array" reddens all three.

### N-T9 — production-run label pinned
- Action: the production-run assertions now end-anchor the label (`… reviewed "nodes" —
  review`, `… reviewed "nodes"\n`).
- Red-proof: forcing the whole-tree label on both runs reddens both.

### A2 — line number of a joined comment-plus-step line
- Accepted. This predates the branch and comes from the backslash joiner, which reports
  the first raw line of a logical line.
- Anti-Deferral check:
  - Worst case: the message points one line above the step it names.
  - Likelihood: needs a comment ending in `\` directly above a masked verifier.
  - Cost to fix: low, but it changes the line attribution for every joined shell
    continuation, where the first line is the right anchor. Not worth the churn.
