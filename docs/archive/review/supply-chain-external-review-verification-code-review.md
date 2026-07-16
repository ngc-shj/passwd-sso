# Code Review: supply-chain-external-review-verification

Date: 2026-07-16
Review round: 1
Mode: Verification of an EXTERNAL review (npm provenance / release supply-chain, P1-P3 findings produced against a ZIP snapshot) against actual code on `main`. No branch diff — targets are files on main: `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `.github/workflows/dependency-signatures.yml`, `cli/package.json`, `Dockerfile`. Seed source: external review text (Ollama seed generation skipped — no diff exists; the external review itself served as the seed set).

Context: the reviewed pipeline shipped deliberately in commit `169c06839` ("feat(supply-chain): pin npm provenance, add signature verification + crypto/auth dep governance", PR 669). The external findings are hardening gaps in a recent intentional design, not regressions.

## Changes from Previous Round

Initial review.

## External Seed Disposition (consolidated)

| External finding | Verdict | Calibrated severity |
|---|---|---|
| P1: `id-token: write` job runs `npm ci`/build/`prepublishOnly` | **Verified** — structure confirmed; job-level permissions mean every step can mint OIDC token; `esbuild` install script runs (cli lockfile has 2 `hasInstallScript` pkgs: esbuild + darwin-only fsevents) | **Major**, not P1/merge-blocker: exploitation requires a compromised dep already in the human-reviewed lockfile (Dependabot auto-merge forbidden + enforced; lockfile integrity hashes). Privilege-separation gap, not active vuln. Note: already merged to main, so "merge blocker" framing is moot. |
| P2: signatures verified after `npm ci` | **Half wrong** — "audit before install" is infeasible: `npm audit signatures` requires installed node_modules (experimentally proven: `found no dependencies to audit`). Correct fix is `npm ci --ignore-scripts` → audit (experimentally proven working). Impact overrated: all four jobs run `contents: read`, zero secrets in ci.yml, `persist-credentials: false` in weekly sweep | **Minor** (hardening) |
| P2: provenance check "existence only" | **Partially verified** — predicateType-only confirmed; but "existence-only" undercounts (exact match, 5x retry, structurally fail-closed) and limitation is documented as L1. NEW finding: L1 comment's compensating claim ("weekly sweep re-verifies officially") is inaccurate — the sweep verifies installed dependencies; nothing ever verifies published `passwd-sso-cli` itself | **Minor** |
| P3: npm self-bootstrap unverified | **Verified** — version-pinned not digest-pinned; release.yml variant additionally lacks `--ignore-scripts` (Dockerfile variant has it). Counter-finding: external proposal (use setup-node bundled npm) is WRONG for dependency-signatures.yml — .nvmrc=Node 20 → npm 10, silently downgrading the verifier and defeating L2 parity | **Minor** |
| P3: Dockerfile npm/prisma patching | **Verified factually** — migrate compose service does use the runner stage; prisma installed there for it. `target: deps` separation feasible (established pattern in docker-compose.override.yml). Fail-closed patch assertions genuine; residual: version-string checks ≠ content digests | **Minor** (design tradeoff) |
| Praise claims (SHA pinning, supply-chain checker, CODEOWNERS, digest-pinned base) | **All accurate**; checker additionally has a red-proven self-test wired into vitest (not mentioned by external review) | — |
| pre-pr 30 pass / 8 fail attribution | **Plausible; reconstructs exactly** (6 git-dependent + 2 tsx-dependent). Caveat: not all 30 passes are evidence — `check-e2e-selectors.sh` false-greens without git (M2) | — |
| Citation accuracy | **Zero drift** — every cited line/content matches main | — |

## Merged Findings

### Major

**M1 — `id-token: write` job executes third-party code before publish** — `.github/workflows/release.yml:32-57` (Security F1; Functionality P-A/F5; Testing S1/F3 — 3-perspective convergence)
`npm ci` (no `--ignore-scripts`; esbuild install script runs), `npm run build` (tsc), and `prepublishOnly` all execute while the OIDC token is mintable. A compromised dep could publish a tampered `passwd-sso-cli` WITH valid SLSA provenance.
Fix (feasibility verified): 2-job split — build job (`contents: read`, `npm ci --ignore-scripts`, build, `npm pack`, sha256 as job output, upload-artifact SHA-pinned) + publish job (`id-token: write` only, download, hash-verify, `npm publish ./passwd-sso-cli-*.tgz`). Verified in npm 11.x source: tarball publish skips `prepublishOnly` (scripts gated on `spec.type === 'directory'`), and OIDC/provenance paths are spec-type-independent (`publishConfig` read from tarball's package.json). Publish job needs a version source for the INV-C1b assert (tarball filename / job output / light checkout) and MUST retain the assert. Interim one-liner if split deferred: `--ignore-scripts` on release.yml:56 (build is plain tsc — verified no install script needed).

**M2 — `check-e2e-selectors.sh` fails open without a git base ref** — `scripts/checks/check-e2e-selectors.sh:36` (Testing F2; R44/RT7)
`git diff "${BASE}...HEAD" … || true` swallows missing-ref failure → silent pass on gitless/shallow trees (demonstrated by the external ZIP run counting it among "30 passes"). Sibling checks exit 2 loudly. Fix: `git rev-parse --verify --quiet "$BASE"` fail-loud preamble.

**M3 — No detector enforces publish-job hygiene** — `scripts/checks/check-workflow-supply-chain.mjs:182` (Testing F3)
Nothing forbids (re-)introducing `npm ci`/build/unpinned installs into an `id-token: write` job — the M1 remediation would be convention-only and could regress silently. Fix: per-job detector using existing `splitJobs()` infra + red-proof cases in the checker's self-test; same detector family can carry the tarball-publish invariant.

**M4 — npm pin `11.12.1` triplicated with no lockstep guard** — `Dockerfile:94-95`, `release.yml:51`, `dependency-signatures.yml:50` (Security F5 = Testing F1; R33/R2/R3 — convergence, severity floor Major)
Comments claim lockstep ("matches Dockerfile NPM_VER", L2) but no gate enforces it, unlike the prisma pin (`check-dockerfile-prisma-pin.sh`). Partial bump silently breaks producer/verifier attestation-format parity. Fix: extend the pin check or supply-chain checker to assert the three literals match, with self-test.

**M5 — External P-C proposal must NOT be applied to dependency-signatures.yml** — `dependency-signatures.yml:44-50` (Functionality F2)
Dropping the global npm install there runs the verifier under .nvmrc Node 20's bundled npm 10 — silently downgrading attestation verification (fewer verified attestations, no failure). If the global install is ever removed, simultaneously raise that workflow to an exactly-pinned Node 24.

### Minor

**m1 — `--ignore-scripts` on audit-only installs; propagation set is FOUR locations** — ci.yml:619, 644, 667 + dependency-signatures.yml:51 (Security F3 = Functionality F1/F5; external review enumerated only 3). Experimentally proven working (`npm ci --ignore-scripts` → `npm audit signatures`: 141 sigs / 32 attestations verified). Optionally add `persist-credentials: false` to ci.yml audit checkouts.

**m2 — Provenance assert lacks digest tie; L1 comment inaccurate** — release.yml:78-102 (Security F2; Testing S3/F6). Assert `dist.shasum`/subject digest vs the built tarball, or add scratch-install + `npm audit signatures` of the published package (extends weekly sweep); correct the L1 comment ("weekly sweep re-verifies officially" — it never verifies passwd-sso-cli itself). Parser fail-closed direction mitigates the never-red-proven gap.

**m3 — Registry fetches without content-digest verification** — release.yml:51 (also lacks `--ignore-scripts`), dependency-signatures.yml:50, Dockerfile patch tarballs (Security F4 incl. external S4/S5). Add `--ignore-scripts` to release.yml:51; record sha512 integrity for Dockerfile patch tarballs.

**m4 — Masked-verifier detector keys on literal command shapes** — check-workflow-supply-chain.mjs:101-104 (Testing F4). A future verifier swap (cosign/slsa-verifier/gh attestation) exits coverage; extend regex + self-test in the same PR as any swap.

**m5 — No meta-gate for scripts/checks/* wiring** — scripts/pre-pr.sh (Testing F5). Currently zero orphans (verified manually); convention-only.

**m6 — Publish flow double-builds CLI** — release.yml:53-69 + cli/package.json:36 (Functionality F6). tsc runs twice (explicit build + prepublishOnly). P-A split removes it; keep `prepublishOnly` for manual publishes.

**m7 — P-C on release.yml floats npm version** — release.yml:42-51 (Functionality F3). Node 24.x bundled npm currently ≥ 11.5.1 (medium-high confidence) but floats, breaking NPM_VER parity; pin exact node-version if ever adopted.

## Adjacent Findings

- Functionality F2/F3/F5 flagged `[Adjacent → security]` (verifier downgrade, npm pin float, propagation set) — absorbed into M4/M5/m1/m7 above.
- Testing S1/S3 npm-behavior questions flagged `[Adjacent → functionality]` — resolved by Functionality expert's source/experimental verification (M1, m2).

## Quality Warnings

merge-findings quality gate: no [VAGUE] / [NO-EVIDENCE] / [UNTESTED-CLAIM] flags.

## Recurring Issue Check

### Functionality expert
R29: PASS (all external citations verified; one npm-behavior claim failed verification → F1). R33: TRIGGERED → F5. R16: PASS with note (Node 24 vs 20 deliberate). R41: PASS (provenance backed under tarball publish; keep assert). Others N/A (CI/packaging feasibility scope).

### Security expert
R3: finding F5 (npm pin triplicated); F4 --ignore-scripts unpropagated. R16: N/A. R29: OK (Trusted Publishing version claims match). R31: N/A. R33: finding F5; audit signatures gate consistent — OK. R41: OK (INV-C1b backs provenance declaration). R44: OK (set -euo pipefail; masking blocked by check-workflow-supply-chain.mjs). RS4: OK. RS5: N/A. Remaining rules N/A.

### Testing expert
R33: FAIL → F1 (npm pin); PASS on pre-pr/CI axis. R44: FAIL → F2 (`|| true` swallow); PASS for pre-pr.sh PIPESTATUS. RT7: PASS for supply-chain checker (red-proven self-test); PARTIAL → F6, F2. RT5-analog: PASS. R2: FAIL (same substance as F1). Others N/A.

## Environment Verification Report

N/A — no plan-phase contracts (verification-of-external-review mode). Empirical claims verified locally: `npm audit signatures` lockfile-only failure and `--ignore-scripts` flow (scratch dir experiments, npm 11.17.0); tarball-publish script skipping and spec-type-independent provenance (npm 11.17.0 source inspection). Registry end-to-end (tarball publish under Trusted Publishing) not exercisable locally — the fail-closed INV-C1b assert is the designated safety net; do a dry-run/canary on first real release after any split.

## Resolution Status

Round 1 was verification-only. User approved the full remediation package; implemented on branch `security/release-publish-job-isolation` and re-reviewed (Round 2 — all fixes confirmed correct + complete, no regression; one latent Minor found and fixed inline).

### M1 [Major] id-token:write job executed third-party code
- Action: split release.yml into `build-cli` (contents:read — checkout, `npm ci --ignore-scripts`, build, `npm pack`, sha256, upload-artifact) → `publish-cli` (id-token:write only — download-artifact, sha256 verify vs build-cli output, `npm publish "$TARBALL"`, INV-C1b assert) → `verify-published` (contents:read — scratch-install + `npm audit signatures`). The privileged job now runs no install/build/lifecycle script.
- Modified: `.github/workflows/release.yml`

### M3 [Major] no detector for publish-job hygiene
- Action: added `findPublishJobIsolationViolation` to check-workflow-supply-chain.mjs — fails the build if any `id-token: write` job runs npm ci/install/build/tsc (pinned `npm install -g npm@X.Y.Z` bootstrap exempted). Mutation-verified (red-proven by injecting `npm ci` into publish-cli). Round 2 hardened the `tsc` regex to also catch path-form (`./node_modules/.bin/tsc`).
- Modified: `scripts/checks/check-workflow-supply-chain.mjs`, `scripts/__tests__/check-workflow-supply-chain.test.mjs` (40 tests pass)

### M4 [Major] npm pin triplicated with no lockstep guard
- Action: added `check-npm-version-pin.sh` (npm sibling of check-dockerfile-prisma-pin.sh) asserting the npm pin is identical across Dockerfile NPM_VER, release.yml, dependency-signatures.yml; wired into pre-pr.sh. Mutation-verified against both release.yml and dependency-signatures.yml drift.
- Modified: `scripts/checks/check-npm-version-pin.sh` (new), `scripts/pre-pr.sh`

### M2 [Major] docs — no code change needed
- Action: no separate fix. The concern (external P-C proposal would downgrade the dependency-signatures verifier) is a "do NOT do this" note; the branch keeps the pinned npm install there and adds `--ignore-scripts`. Recorded so a future simplification does not remove the pin.

### m1 [Minor] audit-only installs run lifecycle scripts before verification
- Action: `npm ci` → `npm ci --ignore-scripts` in the 3 ci.yml audit jobs + the dependency-signatures.yml weekly sweep (and `--ignore-scripts` on the sweep's global npm install). Build/test jobs that legitimately need scripts left untouched (verified: 7 remaining bare `npm ci` are all build/test/prisma jobs).
- Modified: `.github/workflows/ci.yml`, `.github/workflows/dependency-signatures.yml`

### m2 [Minor] provenance assert lacks digest tie; L1 comment inaccurate
- Action: corrected the L1 comment to describe the assert as an emission-liveness check (not cryptographic verification, not subject-digest-bound); added the `verify-published` job that cryptographically verifies the published package via `npm audit signatures`, closing the "weekly sweep covers it" inaccuracy.
- Modified: `.github/workflows/release.yml`

### m4 [Minor] masked-verifier detector keys on literal command shapes
- Action: not changed this round. Documented as future work — any verifier swap (cosign/slsa-verifier/gh attestation) must extend the detector regex + self-test in the same PR. No verifier swap in this branch.

### M5/m3/m5/m6/m7 [Minor/informational]
- m3 (registry fetches without digest verification): partially addressed — `--ignore-scripts` added to release.yml global npm install; Dockerfile sha512 integrity pinning deferred (existing fail-closed layout checks retained). m5 (no meta-gate for scripts/checks wiring): deferred (zero orphans today). m6 (double-build): resolved by the split (publish job no longer builds). m7/M5 (P-C float): not applied; pins retained.

### Round 2 finding F1 [Minor] — fixed inline
- Action: broadened the `tsc` regex in findPublishJobIsolationViolation to catch path-form invocations. Added two tests (path-form flagged, `tsconfig` not false-positived).

## Round 2/3 — Second external re-review follow-ups (applied)

Two further external re-reviews of commit `99144fe76` produced findings; all valid ones fixed on this branch and re-reviewed adversarially.

### Medium — verify-published install-retry was fail-open
- Problem: the 5-attempt `if npm install ...` loop did not fail the job when all attempts failed (`set -e` ignores an `if`-condition command), so `npm audit signatures` could run against an empty scratch tree and "pass" without ever fetching the package.
- Fix: explicit `installed=false`/`=true` flag + `exit 1` on total failure; plus post-install checks that `node_modules/passwd-sso-cli/package.json` exists and its version equals the published version. Verified fail-closed in a shell sim.

### High (design) — no registry npm fetch under OIDC; use bundled npm
- Decision (per user): the OIDC publish job must not fetch npm from the registry at all. Replaced `npm install -g npm@11.12.1` in publish-cli/verify-published with the npm bundled in the SHA-pinned setup-node's official Node distribution. Pinned `PUBLISH_NODE_VERSION: "24.15.0"` (which bundles npm 11.12.1, verified against nodejs.org/dist/index.json, ≥ Trusted Publishing floor 11.5.1) as a workflow-level env, with a runtime `node --version`/`npm --version` assert in each job. build-cli uses the same bundled npm too (drops its registry npm install).
- Guard: `findPublishJobIsolationViolation` updated to forbid ALL npm install (incl. the global bootstrap) in id-token:write jobs. Mutation-verified.

### Medium — published tarball not bound to built bytes
- Fix: build-cli records `integrity` (`sha512-<base64>`, verified byte-identical to `npm pack --json`'s integrity = npm's dist.integrity). verify-published compares the registry's `dist.integrity` for the published version against it, failing closed on mismatch. Also reworded the L1 comment to state plainly it is only an emission-liveness/presence check, not authenticity.

### Guard robustness (from re-review + adversarial pass)
- `check-npm-version-pin.sh` (cross-file identity) replaced by `check-publish-toolchain.sh` (role-based: publish job pins exact Node patch + declares npm ≥ floor + no registry npm fetch; verifier & Docker each pinned for their own role, not required to match). Rewired in pre-pr.sh. Mutation-verified.
- `findPublishJobIsolationViolation` hardened: inspects only `run:` command text (no `name:`/comment false-positive), joins block scalars + line-continuations (split-command bypass closed), detects top-level `id-token: write`, and covers all npm install/exec aliases (`npm i`/`add`/`ci`/`exec`/`x`, `pnpm dlx`) — the last from the final adversarial pass (a `npm i` would otherwise have slipped through). `findTrustedPublishNodeViolation` resolves `node-version: ${{ env.X }}` via a new `parseTopLevelEnv`.
- Self-test grew to 59 cases; all new invariants red-proven.

### Round 3 — Low regression-gate gap (third re-review, applied)
- Problem: `check-publish-toolchain.sh`'s floating-Node detection (`grep "2[0-9]"`) missed `node-version: "24.x"` / `"24.15"` / unquoted `24`, and a job could pin a floating literal while the top-level `PUBLISH_NODE_VERSION` env stayed valid — the gate would pass. `findTrustedPublishNodeViolation` intentionally stays a floor check (accepts `24.x`), so it does not cover the exact-pin invariant either.
- Fix: replaced the value-blocklist with a positive-form structural check — every `node-version:` line in release.yml must be exactly `${{ env.PUBLISH_NODE_VERSION }}` (any literal or `node-version-file:` is a violation), and `PUBLISH_NODE_VERSION` itself must be full `X.Y.Z`. Both bypass paths (job-level floating literal with valid env; floating env value) mutation-verified red.

### Round 4 — third re-review follow-ups (applied)
- **High — Node 24.15.0 carried a known-vuln (pre-24.17.0 security release).** Bumped `PUBLISH_NODE_VERSION` 24.15.0 → 24.18.0 (current 24.x LTS) and `PUBLISH_NPM_VERSION` 11.12.1 → 11.16.0 (the npm 24.18.0 bundles; verified against nodejs.org/dist/index.json). Both still meet the Trusted Publishing floor.
- **Low — exact-match gate was a substring match.** `check-publish-toolchain.sh` used `grep -vF 'node-version: ${{ env.PUBLISH_NODE_VERSION }}'`, which accepted `${{ env.PUBLISH_NODE_VERSION }}.x` (contains the fixed string). Replaced with a whole-line anchored regex; the `}}.x` bypass is now mutation-verified red.
- **Low–Medium — provenance source-identity not asserted.** Added a `verify-published` step that fetches the registry attestation bundle and asserts the SLSA provenance names THIS repository as the source (`github.repository`). `npm audit signatures` proves cryptographic validity; this adds the WHICH-repo binding. Parser tested against a sample SLSA v1 bundle (match → OK, wrong repo/no-provenance/malformed → fail closed). Documented as fail-closed best-effort parse.
- **Guard durability (reviewer suggestion).** Added `scripts/__tests__/check-publish-toolchain.test.mjs` (10 fixture cases via new `PUBLISH_TOOLCHAIN_*` path overrides): exact-patch, floating-major/partial, literal-vs-env, `}}.x` partial-match, node-version-file, real-vs-comment npm install, npm floor. Added a comment on `isTrustedPublishingNodeVersion` clarifying it is a floor check, not the exact-pin invariant (owned by the toolchain gate) — so a future reviewer does not read the two gates as contradictory.

### Round 5 — provenance source-identity completed (fourth re-review, applied)
- **Medium (false-green) — provenance verified repo only.** The prior step read `EXPECTED_SHA` but never compared it, checked no workflow/ref, and fell back to scanning `resolvedDependencies` for any GitHub URI (so an attacker's provenance listing our repo as a mere dependency could pass). Replaced the inline `node -e` with a standalone, unit-tested `scripts/checks/verify-npm-provenance-source.mjs` that requires an exact match on repository AND commit SHA AND workflow path, plus ref when supplied. The `wf.repository` source field is now mandatory (no dependency-scan fallback); missing repo/commit/workflow all fail closed. verify-published gained an `actions/checkout` (unprivileged) so the script is available.
- Test: `scripts/__tests__/verify-npm-provenance-source.test.mjs` — 14 fixture cases covering the full identity table (all-match; SHA/workflow/ref/repo mismatch; missing commit/repo; no provenance; corrupt payload; expected-repo-as-dependency-only; multi-provenance with one full match; non-object bundle; missing expected inputs).

### Round 6 — provenance verified against SIGNED bundles + inner-statement checks (fifth re-review, applied)
- **Medium — parser consumed an unsigned re-fetched bundle.** The step ran `npm audit signatures` (cryptographic), then separately `curl`ed the attestation bundle and parsed that unsigned copy — so identity was asserted on data whose signature this workflow never checked (registry equivocation gap). Now the parser consumes the VERIFIED `attestationBundles` from `npm audit signatures --json --include-attestations` (the same bundles npm just cryptographically verified); the `curl` is gone.
- **Low–Medium — inner signed payload not checked.** The old parser selected on the OUTER (unsigned) `predicateType` only. The rewrite verifies, inside the signed DSSE payload: `_type` is an in-toto Statement, `predicateType` is SLSA provenance v1, `subject` is our package@version (with the subject sha512 digest bound to build-cli's tarball integrity — confirmed against real npm data that subject sha512 == dist.integrity), and `runDetails.builder.id` is a GitHub-hosted runner. Plus the existing exact repo/commit/workflow/ref binding.
- **Low — source-dependency URI was a prefix match.** `startsWith("git+https://github.com/<repo>")` also matched `<repo>-evil`. Replaced with a boundary-anchored exact repo extraction (`isThisRepoUri`), so a similarly-named repo no longer satisfies the commit lookup. (This was flagged in the fifth re-review and was already fixed in this same rewrite.)
- Test: `verify-npm-provenance-source.test.mjs` grown to 21 cases (added: package-not-verified, inner statement-type/predicate-type lies, subject-package mismatch, subject-digest binding match+mismatch, builder mismatch, prefix-collision `passwd-sso-evil`). Parser validated END-TO-END against real `npm audit signatures --json --include-attestations` output (a real published package's verified bundle → OK with correct repo/sha/workflow/ref/builder extraction).

### Round 7 — final tightening (sixth re-review said merge-OK; applied 2 Lows)
- **Low — builder/statement-type allow-set was broader than needed.** This flow pins its toolchain, so back-compat values are unnecessary. Tightened `_type` to exactly `https://in-toto.io/Statement/v1` and builder to exactly `https://github.com/actions/runner/github-hosted` (dropped the non-hosted `actions/runner` and `Statement/v0.1`). Added tests that both older forms now fail closed. Re-validated against real `npm audit signatures` output — a real GitHub-published package still verifies (its builder is the hosted runner, its statement type is v1).
- **Low — `npm audit signatures` ran twice.** The comment said "tee" but it was two network verifications (extra latency + false-red surface). Now runs once in `--json --include-attestations` form (which also exits non-zero on failure — verified: left-pad with no signature → exit 1; a fully-verified tree → exit 0), and a human-readable summary is printed from that JSON plus a belt-and-suspenders missing/invalid check.
- The sixth re-review's one non-blocking note (accept a future `#commit` URI form) is intentionally NOT implemented: real npm provenance uses `@ref`, and pre-accepting an unseen form is unnecessary; the current parser fails closed (false-fail, not false-pass) on any unrecognized shape, which is the safe direction.

## Environment Verification Report (Round 2)

- `verified-local`: check-npm-version-pin.sh, check-workflow-supply-chain.mjs, check-e2e-selectors.sh all pass on the real tree; vitest self-test 40/40; new guards mutation-verified (red-proven); `PRE_PR_STATIC_ONLY=1 pre-pr.sh` → 40 passed; `cli/ npm run build` (tsc) → dist/index.js produced.
- `blocked-deferred`: end-to-end release (actual OIDC tarball publish + provenance emission on npm 11.12.1) cannot run outside a real tagged release. Mitigation: the fail-closed INV-C1b assert + the new verify-published job hard-fail the release if provenance/signature is absent. npm-source inspection (npm 11.17 locally) confirmed tarball publish skips lifecycle scripts and provenance is spec-type-independent. Do a canary check on the first real release after merge.
