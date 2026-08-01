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

Evidence: `grep -cE '▸ (Lint|Test|Build|Typecheck)$'` over the run log → **0**.

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
