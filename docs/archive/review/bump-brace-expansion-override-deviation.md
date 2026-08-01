# Coding Deviation Log: bump-brace-expansion-override

## D1 — C5 needed a third edit location the contract did not name

**Planned**: C5 declared two edits to `docs/security/dependency-cve-response.md` —
the Step 3 sentence and the Quick reference row.

**Actual**: a third location carried the same false claim —
`docs/security/dependency-cve-response.md:102`, inside Step 2's post-edit command block:

```
npm run pre-pr                             # full local CI parity
```

**How it was found**: T12(b)'s **mandatory paired read**. Both greps missed it —
`grep 'runs the same.*npm audit'` (T12a) and `grep 'Full pre-PR parity check'` (T12b)
returned no match after the two planned edits, so a grep-only T12 would have reported
pass with the false claim still in the file, one screen above the corrected text.

This is exactly the failure mode round 4's Testing finding predicted when it required
the read to be mandatory (`and`, not `or`). The check caught a real miss on its first
real use.

**Disposition**: fixed in the same contract. C5's I12 ("every command the runbook tells
a responder to run for verification performs the check the surrounding prose claims") is
satisfied only with this third edit, so it is within the contract's intent even though
its Change section named two locations. Verified after the fix:
`grep -niE 'pre-pr.*(parity|same.*audit|audit.*same)'` → no match.

## D2 — Observation recorded, deliberately NOT acted on

`docs/security/dependency-cve-response.md` Step 2 still instructs:

```bash
rm -rf node_modules package-lock.json
npm install                                # regenerates lock with override
```

…followed by "The lockfile churn is expected; commit it."

This PR's actual practice was a plain `npm install` with the lockfile left in place,
which produced a **12-line** lockfile diff (the two intended packages and nothing else)
rather than a full regeneration. That bounded diff is what made C2/I5's churn check
meaningful — a regenerated lockfile would have made "every changed hunk names a
member-set package" unverifiable by inspection.

**Why not changed**: C5's locked scope is the two false *statements*. Rewriting Step 2's
procedure is a different change with its own trade-offs (a full regeneration does have
value when the override interacts with a dep tree that has drifted). Recorded here and
surfaced to the maintainer rather than bundled in.

## D3 — Resolved versions recorded, not assumed (R-b)

The plan's R-b required recording which versions the caret floors actually resolve to
rather than assuming. Observed:

| override | floor | resolved |
|---|---|---|
| `brace-expansion@1` | `^1.1.17` | **1.1.18** |
| `brace-expansion@2` | `^2.1.3` | **2.1.4** |
| `brace-expansion@>=3.0.0 <5.0.8` | `^5.0.8` | not exercised — nothing resolves into the band (M3-M6 stay 5.0.8) |
| `js-yaml@>=3.0.0 <3.15.0` | `^3.15.0` | not exercised — nothing resolves into the band |
| `js-yaml@>=4.0.0 <4.3.0` | `^4.3.0` | **4.3.0** (unchanged) |
| `js-yaml@>=5.0.0 <5.2.2` | `^5.2.2` | not exercised — nothing resolves into the band |

All exercised resolutions are outside every band of every advisory checked. The three
unexercised keys are the deliberate speculative coverage of Class B / Class C bands
nothing currently occupies — their correctness rests on the band arithmetic (T11/T13),
not on an observed resolution, which is why I16 predicted zero churn for `js-yaml` and
the observed diff confirms it.

## D4 — Deferred parity gaps (Step 2-1 item 7)

| CI gate | runs locally? | disposition |
|---|---|---|
| `npm audit --omit=dev --audit-level=high` (×3: app/ext/cli) | not in `pre-pr.sh` | **Run manually** — T2/T3. This is the gap the runbook's Step 3 wrongly claimed did not exist; C5 now documents it. |
| `npm audit signatures` (×3) | not in `pre-pr.sh` | **Deferred to CI.** Cost-justification: it performs live registry attestation lookups for the whole tree, is network-bound and slow, and cannot fail as a consequence of an override-floor change that resolves to published, already-signed releases. |
| `Trivy: Container image scan` | not in `pre-pr.sh` | **Deferred to CI** (VC1). Cost-justification: requires a full `docker build`. C4 establishes the image surface is untouched — `Dockerfile` `BE_VER=5.0.8` lies outside every band and the file is not in the diff. |
| `npm run licenses:check:strict` (+ `:ext` / `:cli`) | not in `pre-pr.sh` | **Run manually** — T7. |
| `codeql`, `dependency-signatures`, `tls-fixture-expiry`, `refactor-phase-verify` | not in `pre-pr.sh` | **Deferred to CI.** Cost-justification: none of them reads `package.json` `overrides` or the lockfile; the diff contains no source, no TLS fixture, and no refactor-phase manifest. |

## D5 — `scripts/pre-pr.sh` reported "61 passed" without running Lint / Test / Build

**What happened**: the Phase 2 verification cited a green `pre-pr` run as covering T8
(`npx eslint .`), T9 (`npx vitest run`) and T10 (`npx next build`). It did not.
`detect_web_changes()` in `scripts/pre-pr.sh` gates those steps on
`git diff --name-only $(git merge-base origin/main HEAD)...HEAD` — the **committed**
diff. At the time of the run, the branch's only commit touched
`docs/archive/review/*.md`; the entire implementation was uncommitted. The web filter
therefore saw no app paths, skipped the four web steps, and the 61 passing steps were
all static gates.

**Evidence — and a correction to the evidence originally cited here.** This entry first
cited `grep -cE '▸ (Lint|Test|Build|Typecheck)$'` over the run log returning **0**. That
command is itself a can't-fail check: `scripts/pre-pr.sh` colorizes every step label
unconditionally, so the raw bytes are `\x1b[1m▸ Lint\x1b[0m` and the reset escape sits
between the label and the newline. A `$`-anchored pattern therefore **never** matches,
whether the step ran or not — Phase 3's Testing review re-ran the identical command
against a log where the four steps demonstrably *did* run and still got 0. Citing it as
proof of a skip was an R50 instance inside the entry written to correct an R50 instance.

The evidence that actually holds:

1. Strip the escapes first — `sed 's/\x1b\[[0-9;]*m//g' <log> | grep -cE '▸ (Lint|Typecheck|Test|Build)$'` — which returns 4 on a run where they executed.
2. The pass count moved **61 → 69** once the implementation was committed, matching the
   +8 web-step delta already recorded in `project_pre_pr_web_filter_reads_committed_diff`
   from an earlier observation of this same behavior.
3. Neither of those is what closes the gap. The four checks were run **directly**, exit
   status read from the command itself with no pipe in between — see D7 for the
   transcript. A pass count is not coverage, and that applies to 69 exactly as it applied
   to 61.

**Why this matters here specifically**: T8 was not an incidental check. The plan chose
it because ESLint's own dependency chain (`eslint → minimatch → brace-expansion`) is a
direct consumer of the package this PR patches — it is the check most likely to notice a
bad resolution. Citing a run that never executed it is R50 (success inferred from a
proxy signal): a pass **count** was read as coverage without checking the analyzed
subject's identity.

**This was a known trap.** `project_pre_pr_web_filter_reads_committed_diff` records
exactly this behavior, from an earlier run on this same branch. The memory existed and
was not applied — a process failure, not a tooling gap.

**Resolution**: the three checks were run directly against the real (uncommitted) state
and all pass — `npx eslint .` exit 0 with no output; `npx vitest run` → 1006 files /
13955 passed, 1 skipped; `npx next build` → compiled successfully. `pre-pr` is then
re-run **after** committing, at which point `detect_web_changes()` sees the app paths
and the web steps execute for real.

**Rule for the rest of this work**: `pre-pr` and any `main...HEAD` check are meaningless
against uncommitted work. Either commit first, or set `PRE_PR_FORCE_FULL=1`, or run the
individual commands. Never read a pass count as coverage.

## D6 — The contract conformance grep was vacuous for the same reason, and exposed a bad forbidden pattern

**What happened**: the Phase 2 conformance check ran
`git diff main...HEAD -- package.json package-lock.json docs/security/ | grep -nE "^\+.*$pattern"`
and reported all seven patterns absent. With the implementation uncommitted, that diff
was empty — every pattern was "absent" because there was nothing to search. Same root
cause as D5.

**Re-run against the working tree** (`git diff`, no `main...HEAD`): six patterns genuinely
absent; one matched —

```
+**`npm run pre-pr` does NOT run `npm audit`.** It bundles lint, tests,
```

against C5's forbidden pattern `npm run pre-pr.*npm audit`.

**Assessment**: not a defect in the diff. The matched line is the sentence that *fixes*
the false claim. The pattern is negation-blind — it matches the two nouns regardless of
the "does NOT" between them, so it fires on its own remedy.

**Resolution**: C5's forbidden pattern changed to `pre-pr.*(runs the same|parity)`,
anchored on the words that carry the false claim rather than on nouns common to the claim
and its correction. Re-verified: no match in the working tree. A forbidden pattern that
fires on its own fix is worse than no pattern, because it trains the reader to wave the
check through.

## D7 — Verification transcript (satisfies C3's acceptance criterion)

C3's acceptance reads: *"the commands run and their output is recorded in the deviation
log."* Phase 3's Testing review found that criterion unmet — the log recorded the
*decision* to run the audits manually (D4) but never their output, so the PR's central
security claim (I7) had no evidence in the committed record. Recorded here.

**Audit scopes** — each exit status read from the command itself, no pipe between the
command and `$?` (R44):

```
npm audit                                  exit=0 :: found 0 vulnerabilities
npm audit --omit=dev --audit-level=high    exit=0 :: found 0 vulnerabilities
cli: npm audit                             exit=0 :: found 0 vulnerabilities
extension: npm audit                       exit=0 :: found 0 vulnerabilities
```

I7 (full scope clean) and I8 (production scope not regressed) both hold. I8 was green
before the change too — it is a regression guard, and I7 is the check that proves the
fix.

**Mandatory checks** — run directly rather than inferred from `pre-pr`'s pass count
(D5). Output redirected to files; exit status read immediately:

```
npx eslint .        exit=0   (0 bytes of output)
npx tsc --noEmit    exit=0   (0 bytes of output)
npx vitest run      exit=0   Test Files 1006 passed (1006)
                             Tests 13955 passed | 1 skipped (13956)
npx next build      exit=0   ✓ Compiled successfully in 8.6s
                             ✓ Generating static pages (243/243)
```

Note on a first attempt at this transcript: the four commands were chained inside one
`{ ...; } | grep -v ... | tail -40` pipeline, which produced `eslint_exit=2` and a build
summary reading "1 routes … Errors: 1". Both figures are wrong — the re-run above gives
exit 0 with zero output for eslint and a 243-route build. **The mechanism was not
diagnosed**, and two candidates are consistent with what was observed: the ordinary R44
shape (`$?` read after a filter reports the filter's status, not the command's) and
mangling by this environment's output-compressing command proxy, whose truncation marker
appeared in the same output. Recorded as an unexplained anomaly rather than an attributed
one, because attributing it to the tooling would invite the next reader to stop
suspecting their own pipeline — which is the more common cause and the one they can fix.
The operative lesson stands either way: read exit status from the command itself, with
nothing between it and `$?`.

**Licenses** (T7): `npm run licenses:check:strict` → `PASSED (strict) — allowlisted=15,
unreviewed=0, expired=0`; `:ext:strict` and `:cli:strict` → `PASSED (strict)`.

**`pre-pr`**: 69 passed after committing (61 before, when the web filter had nothing
committed to see). Recorded as context, not as evidence — see D5 item 3.

## D8 — Phase 3 Round 1 findings, all applied

| finding | severity | disposition |
|---|---|---|
| Functionality | — | **No findings** |
| Security F1 — the runbook's disjointness check is unsound for inclusive upper bounds | Major | **Fixed.** `<=X` and `>=X <Y` overlap at exactly X, and the stated check (`lower >= previous upper`) reads `X >= X` as disjoint; the shared version then resolves by JSON key order. Step 4 now requires half-open exclusive-upper ranges, states that the check is only valid for that form, and shows the counterexample. This is a verifier whose own input space was never derived — the check was correct for the keys this PR ships and wrong for the shape a future responder could write. |
| Security F2 — the runbook presents `npm run pre-pr` as covering lint/test/build with no commit-first caveat | Major | **Fixed.** Step 3 now states that `detect_web_changes()` reads the committed diff, that the four steps are silently skipped otherwise, and gives the ANSI-stripped grep to confirm they ran. This is the same defect class as the audit claim C5 was written to fix, left standing for the adjacent claim — and D5 is the proof it bites, since this PR's own Phase 2 fell into it. |
| Testing F1 — D5's cited evidence grep can never match | Major | **Fixed.** See the corrected evidence block in D5. |
| Testing F2 — C3's acceptance (audit output recorded) unmet | Major | **Fixed.** See D7. |

## D9 — Three rounds of the same defect class, closed by changing the mechanism rather than adding cases

Phase 3 rounds 1-3 each found the same shape, always in guidance I had just written, never
in the shipped override keys:

| round | what I wrote | how it was falsified |
|---|---|---|
| 1 | disjointness check: "sort keys by lower bound; each lower bound `>=` the previous upper bound" | unsound for inclusive upper bounds — `pkg@<=X` and `pkg@>=X <Y` pass the check while both selecting X |
| 2 | "write every range as `>=floor <ceiling`, the form every key in this file already uses" | false — `brace-expansion@1` / `@2` are bare-major selectors, as is the file's own worked example |
| 3 | a table translating each selector form to a half-open interval, "every npm selector form has one" | the `>X` row broke the stated algorithm, and one npm invocation found six accepted forms with no row: `*`, `""`, exact pins, hyphen ranges, `~`, prerelease-tagged bounds, and `$ref` values |

Each fix enumerated more cases and each was falsified by a case outside the enumeration.
That is the accretion signature: a member-set that grows every round is evidence the class
was never derived from the right primitive. The primitive here is not "which spellings can
a selector have" — it is **npm's own range parser**, and every hand-written table is a
second parser standing in for it, guaranteed to disagree on the spelling nobody thought of
(R47: surface-form adjudication where an interpreter defines the meaning).

**Mechanism change**: the table is gone. Step 4 now hands the predicate to `semver`, which
is already in the tree and is the same library npm resolves with:

```
semver.intersects(rangeA, rangeB)
```

The runbook carries a runnable snippet that walks the `overrides` block, groups keys by
package, and reports every intersecting pair. Verified against every form the round-3
review found missing, plus the two counterexamples earlier rounds turned on:

```
disjoint  "1"              "2"                    disjoint  "<=1.1.16"       ">1.1.16"
disjoint  "1"              ">=3.0.0 <5.0.8"       OVERLAP   "<=1.1.17"       ">=1.1.17 <2.0.0"
OVERLAP   "*"              ">=3.0.0 <5.0.8"       OVERLAP   "1.0.0 - 2.0.0"  ">=2.0.0 <3.0.0"
OVERLAP   "~1.1.7"         "1"                    OVERLAP   "1.1.9"          "1"
```

Note the second row of the right column: `<=1.1.16` vs `>1.1.16` is genuinely disjoint, and
round 3's Functionality lane showed my interval table would have reported it as
overlapping. The interpreter gets both directions right; the table got neither reliably.

**Red-proven** (RT7), on a throwaway copy under the scratchpad — the real `package.json`
was never mutated:

```
GREEN  real package.json          → "override keys are pairwise disjoint"   exit 0
RED    scratch copy + injected
       "brace-expansion@<=1.1.17" → OVERLAP brace-expansion: "1" and "<=1.1.17"   exit 1
```

**Not wired into CI.** The snippet is documentation a responder runs, not a gate. Making it
a `scripts/checks/` entry wired into `pre-pr` is the durable form and is the natural
follow-up, but adding a gate is a repo-policy change of the same kind SC5 defers to the
maintainer — surfaced rather than bundled.

## D10 — The expanded class is closed by a wired, mutation-verified gate

D9 recorded three rounds of the same defect and the mechanism change that ended it
(delegate the predicate to `semver` instead of hand-translating selectors). D9 also noted
the snippet was documentation, not a gate. Per the triangulate termination rule for a
class whose member-set expanded ≥2× — and at the maintainer's direction — it is now a
gate.

**Added**: `scripts/checks/check-override-key-disjointness.mjs`, wired into
`scripts/pre-pr.sh` as `Static: override-key-disjointness`. It walks every `overrides`
block in the repo — root, `cli/`, `extension/`, including nested parent scopes — and
fails when two keys for the same package select intersecting ranges.

**`semver` promoted to an explicit devDependency** (`^7.8.5`, one lockfile line). It was
already in the tree, but only as a transitive hoist, with 6.3.1 also present under other
parents. A gate that depends on which version happens to hoist to the top is the same
"verifier whose input was never derived" mistake in a different costume.

**Red-proven** (RT7). Exit status read with nothing between the command and `$?` —
the first attempt at this table piped through `tr` and read the pipe's status instead,
which is the third instance of that shape in this PR's history and is why the runbook now
says to strip filters before reading a gate's verdict:

| fixture | result | exit |
|---|---|---|
| the repo's own three `overrides` blocks | passed | **0** |
| `brace-expansion@1` + `brace-expansion@<=1.1.17` (inclusive-bound overlap) | OVERLAP | **1** |
| `js-yaml` + `js-yaml@>=3.0.0 <3.15.0` (whole-package key beside a ranged one) | OVERLAP | **1** |
| `rollup@1` + `rollup@>=0.5.0 <2.0.0` nested under `@crxjs/vite-plugin` | OVERLAP | **1** |
| `pkg@latest` (a selector npm itself rejects) | passed, no throw | **0** |

**Committed self-test**: `scripts/__tests__/check-override-key-disjointness.test.mjs`,
15 cases. They pin the shapes that each escaped a review round before being caught by
hand — inclusive upper bound, bare-major selector, whole-package key, hyphen range,
tilde, exact pin — plus scoped-package key splitting, nested-scope isolation, and the
repo's own blocks. The red-proof lives in the suite rather than only in a transcript.

**Runbook de-duplicated**: Step 4 carried an inline copy of the check. Two
implementations of one predicate drift, so the inline snippet is gone and Step 4 points
at the gate.
