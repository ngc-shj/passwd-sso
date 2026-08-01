# Plan Review: bump-brace-expansion-override

Date: 2026-08-01
Review round: 1

## Changes from Previous Round

Initial review.

## Merge method

Ollama `merge-findings` was not used for this round. The mechanical merge pre-pass
(json index join across the three experts + the escalation tier) found the findings
disjoint by `(file, line ±5)` except for one convergent pair, which is recorded
below; a prose merger had nothing to collapse. Recorded per the Step 1-5 fallback
clause.

Local LLM pre-screening (`pre-review.sh plan`): **No issues found.**

## Escalation

Security expert (Sonnet) raised **S1** as Critical with `escalate: true`
(`escalate_reason`: multi-source reasoning chain across three overlapping GHSA
advisories, verified only by live registry queries). The orchestrator independently
confirmed the factual core against the GitHub Advisory API before escalating, then
re-launched the Security expert at **Opus** tier scoped to the still-open remediation
design rather than to re-confirming settled facts.

Opus tier **downgraded S1 from Critical to Minor** and produced the empirical
adjudication recorded as E1-E6. Per the merge rule, the highest tier that ran takes
precedence for overlapping findings: **S1 is recorded at Minor (E1)**. No second
escalation (Fable) — Opus settled the finding in both directions and its analysis is
internally consistent.

## Functionality Findings

### F1 [Major] — Plan does not consult or reconcile with the repo's own CVE-override runbook

`convergent: functionality+security` (see E3 — same file, same root cause; severity
floor raised to Major per "Perspective Convergence as a Severity Signal").

- **File**: `docs/security/dependency-cve-response.md`
- **Evidence**: `git log --all -S'"brace-expansion@1": "^1.1.16"' -- package.json` →
  commit `34aa7758b`, `fix(security): patch brace-expansion (1.x/2.x) + js-yaml DoS
  CVEs (#703)`, which fixed advisory `GHSA-3jxr-9vmj-r5cp`. The advisory this plan
  addresses (`GHSA-mh99-v99m-4gvg`) is a **second, distinct** advisory hitting the
  same override entries. `docs/security/dependency-cve-response.md` exists precisely
  because of "the prior brace-expansion incident (audit finding L3, 2026-05)" and its
  Step 4 prescribes a decision procedure for exactly this case — the plan never opens
  it.
- **Impact**: The plan's stated obligation to verify established repo patterns is not
  discharged. A reader cannot tell whether diverging from the runbook's documented
  default was considered or overlooked, and the runbook is left an incident behind.
- **Recommended action**: cite the runbook, state why the chosen override shape
  diverges from its Step 4 default, and record both advisory IDs.

**Assessment: ACCEPTED.** Reflected in the plan (new "Runbook reconciliation" section,
C5) and, because E3 proves the runbook's guidance is actively harmful as written,
extended to amending the runbook itself in this PR.

## Security Findings

### S1 → E1 [Minor after Opus adjudication] — `overrides` has no key for `brace-expansion` 3.x / 4.x

- **File**: `package.json` (`overrides`)
- **Original Sonnet severity**: Critical, `escalate: true`. **Opus severity: Minor.**
  Recorded at Minor.
- **Evidence (orchestrator-verified via `gh api /advisories/<id>`)**:
  `GHSA-mh99-v99m-4gvg` affects **four** bands — `<1.1.17`, `>=2.0.0 <2.1.3`,
  `>=3.0.0 <3.0.3`, `>=4.0.0 <5.0.8`. `npm audit` reported only the two bands that
  intersect the current tree, and the plan copied that intersection as "the advisory
  range". `GHSA-3jxr-9vmj-r5cp` additionally covers `>=3.0.0 <5.0.7`.
- **Band arithmetic (Opus, confirmed against the registry advisory endpoint)**:
  published 3.x tops out at 3.0.6 and 4.x at 4.0.1, both `< 5.0.7`, so
  `GHSA-3jxr-9vmj-r5cp` covers **100 %** of majors 3 and 4. **There is no safe
  in-major version for 3.x or 4.x**; the first clean release is 5.0.8.
- **Empirical proof the plan as written is insufficient** (scratch project outside the
  repo, synthetic parent requiring `brace-expansion@^3.0.0`):

  | overrides | resolved (1.x parent) | resolved (3.x parent) |
  |---|---|---|
  | baseline `{}` | 1.1.18 | 3.0.6 |
  | plan as written | 1.1.18 | **3.0.6 — vulnerable** |
  | widened `>=3.0.0 <5.0.8` | 1.1.18 | 5.0.9 |
  | per-major `@3`/`@4` keys | 1.1.18 | 5.0.9 |

- **Why Minor and not Critical**: nothing in any of the three tracked lockfiles
  resolves to 3.x or 4.x today, the class is DoS in a build-time glob matcher, and the
  exposure is dev-tree only. It is not RCE / auth bypass / injection / data exposure
  (not Critical) nor access control / crypto misuse / SSRF (not Major).
- **Recommended action**: replace the `brace-expansion@>=5.0.0 <5.0.8` key with
  `brace-expansion@>=3.0.0 <5.0.8` (a strict superset), giving total, disjoint,
  gapless coverage below 5.0.8.

**Assessment: ACCEPTED** at Minor, fixed in this PR (zero lockfile churn — the 5.0.8
entries are already pinned, verified).

### E1-supporting: npm resolves overlapping override keys by silent first-match

Empirically demonstrated (npm 11.17.0):

```
{"brace-expansion@1":"1.1.17","brace-expansion@>=1.0.0 <2.0.0":"1.1.18"}  -> 1.1.17  exit 0
{"brace-expansion@>=1.0.0 <2.0.0":"1.1.18","brace-expansion@1":"1.1.17"}  -> 1.1.18  exit 0
```

Identical declarations, reversed key order, different resolved version, **no warning
or error either way**. This is the mechanism behind E3.

### E2 [Minor] — The plan names the wrong authority for the advisory range

- **File**: `docs/archive/review/bump-brace-expansion-override-plan.md` (R-c, C4/I11)
- **Problem**: the plan prescribes reading the advisory range from `npm audit --json`
  at implementation time. `npm audit` structurally reports only bands that intersect
  the current tree, so following R-c faithfully re-derives the **same truncated range
  that produced this gap**.
- **Impact**: C4's conclusion happens to survive — `Dockerfile:138` `BE_VER=5.0.8` is
  outside the full band `>=4.0.0 <5.0.8` because it *is* the first patched version —
  but it survives by one patch release. Had `BE_VER` been 5.0.7, the truncated range
  would have declared it clean while the advisory covers it.
- **Recommended action**: name `gh api /advisories/<ghsa-id>` as the range authority;
  demote `npm audit --json` to "which bands currently intersect us".

**Assessment: ACCEPTED.** This is the class-level fix — E1 is the instance, E2 is the
mechanism that generated it.

### E3 [Minor → Major by convergence with F1] — Runbook Step 4 produces a silently dead override

- **File**: `docs/security/dependency-cve-response.md:111-112`
- **Problem**: Step 4 says "If a new CVE has appeared on the same package, write a new
  override block with the new bounds rather than mutating the existing one." Followed
  literally here it yields:

  ```
  {"brace-expansion@1":"1.1.16","brace-expansion@>=1.0.0 <1.1.17":"^1.1.17"}
    -> RESOLVED: 1.1.16   (the vulnerable version)   exit 0, no warning
  ```

  The security fix does nothing, and whether it does nothing depends on JSON key
  order — an invisible, unlinted property.
- **Recommended action**: narrow the bullet to *disjoint* bounds and state the
  first-match hazard.

**Assessment: ACCEPTED**, amended in this PR (C5). This PR is the counterexample that
motivates the amendment.

### S2 / E5 [Minor] — No CI gate enforces the full-scope audit the plan's Objective claims

- **File**: `.github/workflows/ci.yml:679, 708, 735`
- **Evidence**: all three `Audit: *` jobs run `npm audit --omit=dev --audit-level=high`.
  No workflow runs a full-scope `npm audit`; `scripts/pre-pr.sh` runs none at all
  (orchestrator-verified: zero matches).
- **Problem**: the plan's Objective is "0 findings on both scopes", but nothing
  re-checks the full scope after merge. This advisory was invisible to every automated
  gate and was found only by an ad hoc run.
- **Severity**: would be Major (R42 trigger (b): the seed is one manually-found
  instance; the class is "CI has no detection surface for dev-tree advisories at all")
  but is downgraded to **Minor** by the explicit `config-only` project-context carve-out
  — not because the underlying gap is small.

**Assessment: DEFERRED with cost-justification — recorded as SC5.** See Anti-Deferral
entry below. Surfaced to the user as a recommended follow-up rather than bundled into
a dependency-bump PR.

### E6 [Minor, Adjacent] — C2/I4 overstates what `npm ci` validates

- **Orchestrator-verified**: `package-lock.json` `packages[""]` holds
  `name, version, dependencies, devDependencies, engines` — **no `overrides` key**.
- **Problem**: I4 claims `npm ci` "fails on a lockfile that disagrees with
  `package.json`". The lockfile does not fingerprint the `overrides` block, so a
  `package.json`-only override edit with a stale lockfile passes `npm ci` silently.
- **Impact**: I4 as written is a verification that cannot fire for C1's subject.

**Assessment: ACCEPTED**, I4 rewritten.

## Testing Findings

### T1 [Major] — T7's command cannot verify the claim it is mapped to (vacuous for this diff)

- **File**: plan, Testing strategy T7 row
- **Evidence**: `scripts/__tests__/check-licenses.test.mjs` runs `check-licenses.mjs`
  against fixture lockfiles under `scripts/__tests__/fixtures/`, none of which
  reference `brace-expansion` or the real `package-lock.json`. Its output is
  byte-identical with or without C1/C2 applied. The command that exercises the real
  lockfile is `npm run licenses:check:strict`, which CI's `license-audit` job runs —
  absent from the plan's table, and with none of the explicit CI-deferral note that
  T6/SC3 carries.
- **Impact**: a reader running T7 believes the license-allowlist interaction was
  checked for this change; it was not.

**Assessment: ACCEPTED.** T7's command replaced with `npm run licenses:check:strict`.

### T2 [Minor] — T5/N1 churn-bounding is human-eyeballed, not mechanically gated

I5's invariant is checked by `git diff --stat` (a count) and a version-line grep;
neither computes the reachable-package closure. The pass criterion is a human reading
the output. Bounded impact (a stray hunk is a diff-review nuisance, not a correctness
regression), and per the `config-only` carve-out a script is over-engineering here.

**Assessment: ACCEPTED as informational.** T5 tightened to name the expected changed
paths explicitly so the manual read has a concrete expectation to check against, and
the manual nature is recorded rather than implied.

### T3 [Minor, Adjacent] — SC3 overstates how pinned CI's npm is

`.github/workflows/ci.yml` pins **Node** via `node-version-file: ".nvmrc"` but never
runs `corepack enable` and does not honor `packageManager: npm@11.17.0` (zero
references). CI's npm is whatever ships with the resolved Node 24 build — the same
class of drift VC2 warns about locally.

**Assessment: ACCEPTED**, SC3/VC2 wording corrected. The `corepack enable` question is
noted as out of scope (pre-existing, repo-wide).

## Orchestrator Findings

### O1 [Major] — The runbook tells CVE responders to verify with a command that runs no audit

- **File**: `docs/security/dependency-cve-response.md:98` (and the Quick reference row
  at line 119)
- **Claim in the doc**: "`npm run pre-pr` runs the same `npm audit` step locally that
  CI does."
- **Verified**: `npm run pre-pr` exists, and `grep -nE 'npm audit' scripts/pre-pr.sh`
  returns **nothing**. The only `npm audit` references under `scripts/checks/` are
  `npm audit signatures` mentions in comments of the supply-chain gate, which is a
  different check.
- **Impact**: Step 3 of the runbook is a false verification. A responder following it
  believes the audit was confirmed locally before merge when no audit ran — R41
  (declared capability without a working backing path) inside a security runbook.

**Assessment: ACCEPTED**, corrected in this PR alongside E3 (same file, same PR).

## Adjacent Findings

- **T3** (Testing → CI config): whether `corepack enable` belongs in CI. Routed to
  Functionality scope; assessed as pre-existing and repo-wide, out of scope for this
  PR (SC6).
- **E5** (Security → Testing/Functionality): F1 is a one-shot state, not an invariant;
  merged into S2 above.
- **E6** (Security → Testing/Functionality): I4 does not hold for C1's subject;
  accepted and fixed.

## Quality Warnings

None. No finding was flagged `[VAGUE]`, `[NO-EVIDENCE]`, or `[UNTESTED-CLAIM]`; every
finding above carries either a command-and-output or an orchestrator-verified citation.

## Anti-Deferral Entries

### S2/E5 [Minor] No CI gate for full-scope `npm audit` — Out of scope

- **Scope-out ID**: SC5.
- **Why it is out of scope**: adding a fourth CI audit step changes the repo's gate
  policy and can turn other in-flight PRs red on dev-tree advisories that have nothing
  to do with them. That is a policy decision for the maintainer, not a side effect of
  a dependency bump.
- **Cost of deferring**: a future dev-only high advisory remains undetected by this
  repo's own gates until someone runs `npm audit` by hand. GitHub's native Dependabot
  alerting provides asynchronous, non-blocking detection in the meantime.
- **Cost of doing it now**: bundles an unrequested CI-policy change into a two-line
  dependency PR, and risks reddening unrelated PRs at merge time.
- **Owner**: surfaced to the maintainer in the Phase 1 report as a recommended
  follow-up PR.

### T3 [Minor] `corepack enable` absent from CI — Pre-existing

- **Scope-out ID**: SC6.
- **Why**: pre-existing and repo-wide; every job in every workflow is affected equally,
  and none of them is affected *by this change*.
- **Cost of deferring**: CI's npm version can drift with the runner image. For an
  override-floor bump the resolution is insensitive to npm minor versions; for a more
  sensitive lockfile change it would matter.
- **Owner**: no owner assigned — recorded so a future lockfile-sensitive change knows
  the pin is Node-only.

## Recurring Issue Check

### Functionality expert

- R1 — N/A: config-only change, no new helper code.
- R2 — Checked: searched for other files pinning a `brace-expansion` version (license allowlist, manifests under `scripts/checks/`); none besides `package.json`/`package-lock.json` and the Dockerfile `BE_VER` (covered by C4).
- R3 — Checked: re-ran the lockfile-enumeration across all three tracked lockfiles; result identical to M1-M6; overrides are not nesting-depth-limited.
- R4 — N/A: no mutation/event code touched.
- R5 — N/A: no DB code.
- R6 — N/A.
- R7 — N/A: no UI/selectors.
- R8 — N/A.
- R9 — N/A.
- R10 — N/A.
- R11 — N/A.
- R12 — N/A.
- R13 — N/A.
- R14 — N/A.
- R15 — N/A: no migrations.
- R16 — Checked: VC2 correctly flags local npm 11.17.0 vs CI npm via `.nvmrc` Node 24, CI treated as authoritative; matches the actual setup.
- R17 — N/A.
- R18 — Checked: `scripts/license-allowlist.json` has no `brace-expansion` pin, so no allowlist entry needs updating in either direction.
- R19 — N/A: no exported symbols changed.
- R20 — N/A: two-line JSON value change, not a mechanical multi-line insertion.
- R21 — N/A at plan stage; Phase 2/3 must re-run T1-T3, T9, T10 directly.
- R22 — N/A.
- R23 — N/A.
- R24 — N/A.
- R25 — N/A.
- R26 — N/A.
- R27 — N/A.
- R28 — N/A.
- R29 — Checked: the advisory range and fixed versions were independently verified against `npm audit --json` and `npm view brace-expansion versions --json`; both matched the plan **as far as the tree-intersected range goes** — see E2 for why that verification was insufficient.
- R30 — Checked: no bare `#<number>`/`@<name>` constructs in the plan.
- R31 — N/A: no destructive operation category applies.
- R32 — N/A.
- R33 — N/A: no CI config changed; the three audit jobs and `license-audit`/`container-scan` all read the same files this plan touches.
- R34 — **Finding F1**: an adjacent, pre-existing runbook left unreconciled; reported, not deferred silently.
- R35 — N/A.
- R36 — N/A.
- R37 — N/A.
- R38 — N/A.
- R39 — N/A.
- R40 — N/A: `package-lock.json` is the only cross-boundary artifact; consumer set enumerated and confirmed.
- R41 — N/A from the Functionality lane (see orchestrator **O1** for the R41 instance found in the runbook).
- R42 — Checked: full re-derivation performed; the plan's lockfile member set is complete with no delta.
- R43 — N/A: this narrows exposure, does not widen any boundary.
- R44 — N/A.
- R45 — N/A.
- R46 — N/A.
- R47 — N/A: the plan delegates "is this safe" to npm's resolver + the advisory DB, not a surface-form string read.
- R48 — N/A: single adjudicator.
- R49 — Checked: C1-C4 declared classes verified against actual behavior; no contract claims a stronger guarantee than it provides.
- R50 — N/A at plan stage; SC3's deferral is cost-justified and CI does run `npm ci` with the pinned `.nvmrc` Node.
- R51 — N/A.
- RS1-RS6 — out of scope (Security lane).
- RT1-RT11 — out of scope (Testing lane).

### Security expert

- R1 — N/A: no new helper/utility; config-only diff.
- R2 — N/A: version floors are the subject, not incidental literals.
- R3 — **Finding S1**: incomplete propagation of the stale-override fix across all vulnerable majors of the same advisory.
- R4 — N/A. R5 — N/A. R6 — N/A. R7 — N/A. R8 — N/A. R9 — N/A. R10 — N/A. R11 — N/A. R12 — N/A. R13 — N/A. R14 — N/A. R15 — N/A. R16 — N/A. R17 — N/A. R18 — N/A. R19 — N/A. R20 — N/A. R21 — N/A. R22 — N/A. R23 — N/A. R24 — N/A. R25 — N/A. R26 — N/A. R27 — N/A. R28 — N/A.
- R29 — **Finding S1**: the plan's cited advisory range is incomplete (missing `>=3.0.0 <3.0.3` and `>=4.0.0 <5.0.8`), verified against the live GHSA record and an independent registry-install reproduction.
- R30 — Checked: no autolink-shaped tokens in the plan.
- R31 — Checked: all verification read-only; the scratch `npm install` ran in an isolated `/tmp` project, not the repo.
- R32 — N/A.
- R33 — Checked: enumerated all seven workflow files for `npm audit` invocations; only `ci.yml`'s three prod-scope jobs and `dependency-signatures.yml`'s signature-only job exist — no drifting duplicate, but see S2.
- R34 — N/A from this lane.
- R35 — N/A. R36 — N/A. R37 — N/A. R38 — N/A. R39 — N/A. R40 — N/A. R41 — N/A.
- R42 — **Finding S1**: re-derived the member set from live advisory data rather than the `npm audit` intersection; majors 3 and 4 are unenumerated, uncovered members.
- R43 — N/A: the fix narrows resolution.
- R44 — N/A: `npm audit`'s exit code is used directly.
- R45 — N/A. R46 — N/A.
- R47 — Checked: the plan delegates safety to the resolver/advisory-DB verdict, not a hand-rolled string comparison. (Its *input* range was incomplete — that is S1/E2, not an R47 violation.)
- R48 — N/A.
- R49 — Checked: C1/C2/C4 "detection or audit only" and C3 "fail-closed verification gate" accurately describe the mechanisms; not overstated. See S2 for the resulting durability gap.
- R50 — N/A beyond S2's covered gap.
- R51 — N/A: `overrides` keys are semver-range-bound, not name-bound in the R51 sense.
- RS1 — N/A. RS2 — N/A. RS3 — N/A.
- RS4 — Checked: no personal-identifying data in the plan or the described diff.
- RS5 — N/A beyond S1.
- RS6 — N/A.

### Testing expert

- R1 — N/A. R2 — N/A.
- R3 — Checked: the member-set derivation is the propagation sweep; verified complete against the actual lockfile.
- R4 — N/A. R5 — N/A. R6 — N/A. R7 — N/A. R8 — N/A. R9 — N/A. R10 — N/A. R11 — N/A. R12 — N/A. R13 — N/A. R14 — N/A. R15 — N/A.
- R16 — Checked: see finding T3 (npm toolchain parity).
- R17 — N/A.
- R18 — Checked: `license-allowlist.json` correctly has no `brace-expansion` entry to update in either direction.
- R19 — N/A. R20 — N/A. R21 — N/A. R22 — N/A. R23 — N/A. R24 — N/A. R25 — N/A. R26 — N/A. R27 — N/A. R28 — N/A.
- R29 — N/A from this lane: the plan cites no RFC/OWASP/NIST standard, only an advisory range, whose verification it defers to implementation time (R-c).
- R30 — Checked: no autolink-shaped tokens.
- R31 — N/A: no destructive commands proposed or run.
- R32 — N/A. R33 — Checked: three audit jobs run the same pattern consistently; no drift.
- R34 — N/A. R35 — N/A. R36 — N/A. R37 — N/A. R38 — N/A. R39 — N/A. R40 — N/A. R41 — N/A.
- R42 — Checked: independently re-ran the derivation command; matches the plan exactly.
- R43 — N/A.
- R44 — Checked: none of T1-T10's commands pipe through a filter that swallows exit status; T5's `git diff | grep` is observational, not a pass/fail gate — see T2 instead.
- R45 — N/A. R46 — N/A.
- R47 — Checked: the plan delegates the safety verdict to npm's resolver + `npm audit --json`.
- R48 — N/A: one adjudicator.
- R49 — **Finding T3**: SC3 overstates CI npm's pinning precision.
- R50 — **Findings T1 and T3**: T7's cited command does not examine the actual subject; SC3's toolchain-pinning precondition is unverified. T1/T2/T3/T4/T6/T8/T9/T10 checked clean on exit-status and subject-identity grounds.
- R51 — N/A.
- RT1 — N/A: no mocks.
- RT2 — Checked: the plan correctly declines to recommend new automated tests for a config-only change.
- RT3 — N/A. RT4 — N/A: no concurrency test.
- RT5 — Checked: T1/T2/T3 call the real `npm audit`, not a mock.
- RT6 — N/A.
- RT7 — Checked for T1, T4, T6, T8-T10 (each provably fails if the fix is absent/wrong); **Finding T1** for T7 (cannot fail for the reason claimed); T2/T3 are honestly scoped by the plan as non-regression guards, not fix-proofs.
- RT8 — N/A. RT9 — N/A.
- RT10 — N/A: no new guard added; T4 asserts concrete expected values, not a re-print.
- RT11 — N/A: no new fixtures.

### Security expert — Opus escalation tier

- R3 — Confirms S1 as a propagation gap; downgrades severity to Minor on exposure grounds.
- R29 — **Finding E2**: the plan names `npm audit --json` as the advisory-range authority, which structurally cannot report non-intersecting bands.
- R41 — **Finding E3**: runbook Step 4 yields an override that declares a capability it does not have (silently dead).
- R42 — Re-derived the class over the *advisory's* bands rather than the tree's; majors 3/4 uncovered.
- R48 — Checked empirically: npm resolves overlapping override keys by silent first-match in JSON key order, with no diagnostic. A shape that cannot overlap is preferred.
- R49 — **Finding E6**: C2/I4 claims `npm ci` validates the `overrides` block; the lockfile does not record it.
- R50 — **Finding E5**: F1 (full-scope audit clean) is a one-shot state enforced by no gate.
- All other R/RS rows — N/A for the escalation's scoped question.

---

# Review round 2

Date: 2026-08-01 · Plan revision reviewed: 2 · Merge: mechanical json-index join (findings disjoint; no prose merge needed)

## Changes from Previous Round

Revision 2 corrected the advisory range to the full 4-band `GHSA-mh99-v99m-4gvg` list with
`gh api` named as authority, added Class B (band → key), replaced the narrow 5.x override key
with the widened `>=3.0.0 <5.0.8`, added contract C5 (runbook corrections), rewrote C2/I4,
replaced T7's vacuous command, and added SC5/SC6 with Anti-Deferral justifications.

## Functionality Findings

### F2 [Major] — I1 labelled "app-enforced, verified by gate" contradicts C1's own Control class
C1's Control class paragraph states the opposite ("detection or audit only… nothing else in the
plan may treat this as a boundary"), and T11's mechanism is a manual read. A Phase 3 reviewer
could read "verified by gate" as "a mechanical check will catch a regression" and skip T11.
**ACCEPTED** — relabelled `(detection only, verified manually per T11)`.

### F3 [Minor, Adjacent] — R-d's `@isaacs/brace-expansion` claim is factually wrong
**Orchestrator-verified**: `npm view minimatch@10.2.6 dependencies` → `{"brace-expansion":"^5.0.8"}`;
`minimatch@10.0.0` → `{"brace-expansion":"^4.0.0"}`; `@isaacs/brace-expansion` appears 0 times in
any lockfile. The claim understated the residual risk it was used to justify — `minimatch@10.0.0`'s
floor sits *inside* the vulnerable band `>=4.0.0 <5.0.8`.
**ACCEPTED** — claim retracted in the plan; replaced with the verified fact, which strengthens the
case for the widened key rather than weakening it.

## Security Findings

### S1-r2 [Minor] — `js-yaml`'s override has the identical missing-band defect
`"js-yaml@>=4.0.0 <4.3.0": "^4.3.0"` covers one band of one advisory. R42 trigger (b): the seed
instance is never the set. **Orchestrator-verified** against `gh api`:
`GHSA-52cp-r559-cp3m` (high) also covers `>=3.0.0 <3.15.0`; `GHSA-pm4m-ph32-ghv5` (high) covers
`>=5.0.0 <=5.2.1`. Resolved copy is 4.3.0 (dev), safely inside the covered band — the same blind
spot that hid the `brace-expansion` 3.x/4.x gap.
**ACCEPTED into this PR** after the maintainer chose inclusion over deferral → contract C6.
The reviewer's sweep of the other 15 override entries found no further members.

### S2-r2 [Minor] — C5's amended Step 4 under-specifies
It names "raise a floor in place" and "add a disjoint block" but not the move this PR actually
performs — *widening an existing selector's lower bound* — and asserts "provably disjoint" with no
method. **ACCEPTED** — Step 4 now names three moves and states the disjointness check explicitly.

## Testing Findings

### T4 [Major] — T12's grep targets a file the fix never touches
`grep -n 'npm audit' scripts/pre-pr.sh` returns zero matches on the *unmodified* repo, so it cannot
distinguish "C5 landed" from "C5 was skipped". Same defect shape as round 1's T1, recurring in the
revision that fixed T1. **ACCEPTED** — T12 rebuilt as a paired positive/negative control on the
runbook file itself.

### T5 [Minor] — T3's "can it fail" label overclaims
`cli/`/`extension/` carry no `brace-expansion` copy, so their audits are invariant to this diff.
**ACCEPTED** — relabelled "no", with the reason recorded.

### T6 [Minor] — T11's "yes" is optimistic
No scripted semver-containment checker exists; T11 is human arithmetic. **ACCEPTED** — relabelled
"manual", with the condition stated.

---

# Review round 3

Date: 2026-08-01 · Plan revision reviewed: 3

## Changes from Previous Round

Revision 3 fixed I1's label and the `@isaacs` claim, added Class C (the R42 trigger-(b) sweep of
every override entry), added contract C6 (`js-yaml`) and SC7, expanded C5's Step 4 to three moves,
and corrected the T3/T11/T12 labels plus a new T13.

## Functionality Findings

### F-R3.1 [Major] — **REFUTED by the orchestrator**
Reported: `cli/`'s postcss override resolves to 8.5.15, inside `GHSA-r28c-9q8g-f849`
(`<= 8.5.17`, high, patched 8.5.18) — a live exposure the Class C sweep missed.
**Refutation evidence**: the committed `cli/package-lock.json` resolves postcss at **8.5.23** and
root at **8.5.22**, both above 8.5.18. The reviewer used `npm ls`, which reads the *installed*
`cli/node_modules` — stale on this machine at 8.5.15. The single `8.5.15` string in
`cli/package-lock.json` is a dependency *range* (`"postcss": "^8.5.15"`, `vite`'s own declared
requirement), not a resolved version. The round-4 Functionality and Security reviewers both
independently confirmed the refutation.
**Methodological half ACCEPTED**: the "structurally immune" verdict for unbounded `>=` floors was a
syntax argument, not a verification. Class C now derives every verdict from the committed
lockfile's resolved version against the live advisory list, with `npm ls` explicitly rejected as an
authority and resolved versions shown per row.

### F-R3.2 [Minor] — C6 lacks the consumer cross-check C1 states for `brace-expansion`
**ACCEPTED** — license-allowlist / Dockerfile / cli+extension absence now stated for `js-yaml`.

### F-R3.3 [Minor] — SC7's "two majors" is imprecise
The band reaches through 0.x, so the jump can be up to three majors. **ACCEPTED**.

## Security Findings

### F-S1 [Minor] — SC7 undercounts the advisories it defers
Five non-withdrawn advisories reach below 3.0.0, not three: `GHSA-xxvw-45rp-3mj2` (critical),
`GHSA-8j8c-7jfh-h6hx` (**high**, code injection), plus three medium. The high-severity one was
omitted entirely. **ACCEPTED** — SC7 and the C6 band table corrected. The deferral decision is
unaffected; the written record of what is being left unpatched was not.

### F-S2 [Major] — the `undici` row's stated rationale is false
Class C claimed "the 8.x line carries its own unpatched advisories". **Orchestrator-verified**:
every 8.x-touching advisory has a `first_patched_version` (8.2.0 or 8.5.0). The entry is clean
**by floor** (7.28.0), and the `<8` cap is not security-justified.
**ACCEPTED** — row rewritten, with an explicit note that nobody should cite it as evidence that
8.x is unsafe.

### No overlap/ordering hazard from C6 — verified empirically
Four synthetic consumers (`^3.0.5`, `^4.0.0`, `^5.0.0`, an in-gap range) resolved identically under
both key orderings (3.15.1 / 4.3.1 / 5.2.3), because the three ranges are genuinely non-overlapping
— npm's silent first-match tiebreak is never invoked. I15/I16 hold.

## Testing Findings

### T14 [Major] — T12, rebuilt to fix a Major finding, covers 1 of C5's 3 edits
C5 commits to correcting the Step 3 sentence, the Quick Reference row, *and* the Step 4 rewrite.
T12's regex keys on `npm audit`, which the Quick Reference row does not contain in any phrasing, and
nothing checks Step 4's content at all. **ACCEPTED** — T12 rebuilt again with four steps covering
all three edits plus the control; orchestrator verified all four fire as designed.

### T15 [Major] — T13/C6 lack the disjointness check T11/C1 gained the same round
I15 is the same-shaped invariant as I2 but had no verification. **ACCEPTED** — added to both T13
and C6's Acceptance.

### T16 [Minor] — SC7's advisory accounting does not reproduce against the plan's own authority
Duplicate of F-S1 from the Testing lane. `convergent: security+testing`; both **ACCEPTED**.

---

# Review round 4

Date: 2026-08-01 · Plan revision reviewed: 4

## Changes from Previous Round

Revision 4 recorded the F-R3.1 refutation and its method note, rewrote Class C to derive verdicts
from lockfile-resolved versions, corrected the `undici` row and SC7's advisory accounting, added
C6's consumer cross-check and disjointness acceptance, and rebuilt T12 to cover all three C5 edits.

## Security Findings

**No findings.** The reviewer independently re-derived 12 Class C rows from the committed lockfiles
plus `gh api` (sharp, cross-spawn, esbuild, qs, lodash, hono, @hono/node-server, nodemailer,
body-parser, find-my-way, @babel/core, effect, undici) — every verdict reproduced. The postcss
refutation was independently confirmed. No new advisory has appeared for either package.

`[Adjacent] Minor`: `@hono/node-server`'s `^2.0.5` is an unbounded floor like `undici`'s; currently
clean (2.0.11 > 2.0.10 patched). Not touched by this PR; noted for awareness only.

## Functionality Findings

### F-R4.1 [Major] — the Class C derivation command false-positive-matches scoped packages
`k.endsWith('/<pkg>')` also matches `@scope/<pkg>`. **Orchestrator-verified live**: querying
`postcss` returns `node_modules/@tailwindcss/postcss` (4.3.3, a different package) alongside the
real `node_modules/postcss` (8.5.22); the same collision fires for `lodash` (`@types/lodash`) and
`nodemailer` (`@types/nodemailer`). The false rows carry no marker, so a sweep reading the first
line gets the wrong version silently. The plan's Class A command had the weaker form still
(`endsWith('brace-expansion')`, which also matches `@isaacs/brace-expansion`).
**ACCEPTED** — all three occurrences changed to `endsWith('node_modules/<pkg>')`, with the reason
recorded. Verified: `"node_modules/@tailwindcss/postcss".endsWith("node_modules/postcss") === false`
while `"node_modules/vite/node_modules/postcss".endsWith("node_modules/postcss") === true`.
No verdict already in the table changes — the correct postcss line had been picked manually.

## Testing Findings

### T-R4.1 [Major] — T12 step (b)'s after-condition restates the can't-fail problem in softer language
"must not match, **or** match only reworded text that no longer claims audit parity" — the second
disjunct has no verification mechanism, so a cosmetic rename that drops the literal string passes
while the substance stays broken. **ACCEPTED** — the read is now mandatory (`and`, not `or`), with
the degradation risk stated inline.

### T-R4.2 [Minor] — T12's "can it fail" column grants (b) the same confidence as (a)
**ACCEPTED** — column now answers per step: (a) yes, (b) partly, (c) yes, (d) no.

### T-R4.3 [Minor] — "T2" label collision between the plan's table row and this review's finding id
**ACCEPTED** — the cross-reference now says "review-finding T2 in
`bump-brace-expansion-override-review.md` (a finding label, not this table's row T2)".

### T-R4.4 [Minor] — C1's Acceptance is asymmetric with C6's despite C6 claiming parity
**ACCEPTED** — C1's Acceptance now restates the lockfile resolved-version bullet.

## Round-4 disposition

Security: clean. The two Major findings and four Minor findings were all defects in the **plan
document**, not in the change it specifies; all are fixed in revision 5. The substantive design
(C1/C6 override shapes, C5's runbook edits) has been stable since revision 3 and was re-derived
independently by both the Functionality and Security reviewers this round.
