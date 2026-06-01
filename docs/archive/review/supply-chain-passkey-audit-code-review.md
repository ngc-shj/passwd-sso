# Code Review: supply-chain-passkey-audit

Date: 2026-06-01
Review round: 1 (triangulation of a manual security audit — no code changed; review of current `main`)

## Changes from Previous Round

Initial review. Three pre-existing findings from a manual audit were triangulated by three
expert sub-agents (functionality / security / testing). All three findings reproduce; two had
their severity and fix refined, one was substantially reframed (downgraded + partly refuted).

## Consolidated Findings (deduplicated across experts)

### S1/F1/T1 — GitHub Actions floating tags + ungated pin-check script — **Major** (was: High)
- **File:** all workflows under `.github/workflows/` (`ci.yml`, `ci-integration.yml`, `codeql.yml`,
  `release.yml`, `refactor-phase-verify.yml`); detector `scripts/checks/check-actions-sha-pinned.sh`.
- **Evidence:** `check-actions-sha-pinned.sh` exits 1 (38 floating refs). `release.yml:21`
  `googleapis/release-please-action@45996ed…` is the *only* SHA-pinned ref. `grep` confirms the check
  script has **zero callers** in CI or `pre-pr.sh` — it is dead code.
- **Problem / Impact:**
  - Mutable tags (`@v6`, `@v4`, `@v0.36.0` — a Git tag is movable) let a compromised action publisher
    retarget the tag to a malicious commit.
  - **Highest blast radius:** `release.yml` publish job holds `id-token: write` (npm Trusted Publishing).
    A poisoned `checkout`/`setup-node` runs inside a job with a live OIDC token → can push a backdoored
    `passwd-sso` CLI to npm. (Mitigated: `id-token: write` is scoped to the publish job, and
    release-please itself is pinned.)
  - **Security-control poisoning:** `codeql.yml github/codeql-action/*@v4` and `ci.yml:519
    aquasecurity/trivy-action@v0.36.0` are *security scanners* — unpinned, a poisoned version can
    suppress findings / exfiltrate source = false assurance (R33).
  - Also a reproducibility defect: a re-tag silently changes CI behavior for the same commit.
- **Fix (ordering matters — R33):**
  1. **First** backfill all refs to `owner/action@<40-hex-sha> # vX.Y.Z` (one mechanical pass).
  2. **Then** wire `check-actions-sha-pinned.sh` into a CI job and `pre-pr.sh`.
  - Reversing the order hard-fails the build. `dependabot.yml` is already present with grouped weekly
    `github-actions` bumps, so ongoing SHA patching is handled after the one-time backfill.

### S1/T2/T3 — Systemic: pre-pr static checks are local-only; multiple security check scripts ungated in CI — **Major** (new, expands F1)
- **File:** `.github/workflows/ci.yml` vs `scripts/pre-pr.sh`.
- **Evidence:** CI never invokes `pre-pr.sh`; it re-runs only a subset (`check:bypass-rls`,
  `check:team-auth-rls`, `check:crypto-domains`, `check:migration-drift`, licenses, test, build).
  Ungated-in-CI security/regression checks include: `check-actions-sha-pinned.sh`,
  `check-fail-closed-routes-have-test.sh`, master-key-rotation CAS guards, `check-vitest-coverage-include.mjs`
  (runs only on `refactor/` branches), `check-e2e-selectors.sh`, `check-security-doc-exists.sh`, etc.
- **Impact:** A contributor who skips the local hook bypasses ~15 static guards with a green CI; CI is not
  the authoritative gate the project assumes.
- **Fix:** Run `pre-pr.sh` (static-only mode) in the `app` CI job, or mirror each local static check as a
  CI step. Wire `check-vitest-coverage-include.mjs` unconditionally (not only on `refactor/`).

### S2/F2/T4 — Dockerfile unpinned `prisma` install, redundant with builder — **Major** (was: High)
- **File:** `Dockerfile:88` `npm install prisma --no-save --ignore-scripts`.
- **Evidence:** Surrounding block pins `NPM_VER`/`TAR_VER`/`PICOMATCH_VER` with fail-closed checks, but
  `prisma` resolves to registry `latest`. `package.json` pins `prisma ^7.6.0` (lockfile → 7.8.0); the
  builder stage already has the lockfile-pinned `prisma` in `node_modules` and the runner already
  `COPY --from=builder` overlays `@prisma/client`/`.prisma` (`Dockerfile:128-129`).
- **Problem / Impact:**
  - `--ignore-scripts` only blocks install-time lifecycle scripts; a malicious/regressed `prisma` version
    still ships poisoned JS + query engine that loads at runtime with `DATABASE_URL` (data path).
  - Functional: CLI/client version skew — `migrate` service reuses this image for `prisma migrate deploy`;
    a newer floating CLI against the 7.8.0-generated client risks engine/schema incompatibility.
  - `--ignore-scripts` also skips prisma's postinstall engine fetch, so the fresh CLI relies on engines
    from the copied client dirs — another reason the copy-from-builder fix is the consistent one.
  - trivy (`ci.yml:519`, `ignore-unfixed:true`) catches published CVEs only — not the pinning defect.
- **Fix (preferred = match existing idiom):** `COPY --from=builder /app/node_modules/prisma ./node_modules/prisma`
  (+ `@prisma/engines`, `@prisma/get-platform` as needed) — mirrors line 128-129, lockfile-exact, zero
  network. Minimum fallback: `npm install prisma@<lockfile-version> --no-save --ignore-scripts` + a drift
  tripwire mirroring the tar/picomatch assertions.

### S3/F3/T(refuted) — Passkey assertion returns ok on counter-persist failure — **Minor / correctness** (was: Medium security)
- **File:** `extension/src/background/passkey-provider.ts:261,278-305` (comment `:290-292`).
- **Reframed by triangulation — three independent corrections to the original finding:**
  1. **Security (scope):** This extension is a *software passkey manager* synthesizing assertions for
     **arbitrary external RPs** (`blob.relyingPartyId`), not passwd-sso's own login. passwd-sso's server
     **does** enforce counter regression (`src/lib/auth/webauthn/webauthn-authorize.ts:174-187` CAS
     `UPDATE … WHERE counter=storedCounter`, + `@simplewebauthn` throws on non-increment). So clone-detection
     risk is **theoretical for this app**, real only for *external* counter-enforcing RPs.
  2. **Functionality (mechanism):** No "permanent stuck counter" — `signCount` is **re-hydrated from the
     server blob every assertion** (`:249`), so a failed PUT self-heals next sign-in. Real residual: the
     *same* counter value is presented twice across two sign-ins → a strict RP (`>` not `>=`) may reject the
     *next* legit sign-in intermittently. Also: a **network** failure is correctly caught (returns
     `{ok:false}` via the `catch`); only an **HTTP 4xx/5xx** PUT swallows to `ok:true`.
  3. **Testing:** The behavior **is tested** — `extension/src/__tests__/background-passkey-provider.test.ts:450-488`
     mocks counter-PUT→500 and asserts `ok:true` + `invalidateCache` not called. Not untested.
- **Net:** Not a security vuln in this app's threat model; behavior is intentional and gated by a test. The
  remaining issue is that the **comment is misleading** — it justifies the in-flight assertion but omits the
  cross-session duplicate-counter consequence.
- **Fix (optional, Minor):** Correct the comment to state the next-sign-in duplicate-counter consequence;
  optionally add a dirty-flag so the failed persist is retried before the next assertion reads the blob.

## Recurring Issue Check (merged)
- **R31 (supply-chain pinning):** Findings S1, S2.
- **R33 (CI security-control gating):** Findings S1, T2, T3, T4 — systemic under-wiring of authored checks.
- **R25 (persist/hydrate symmetry):** F3 — symmetry holds (server-hydrated), which is why the failed persist
  self-corrects rather than deadlocking.
- **R3 (error propagation):** F3 — both PUT failure paths traced; swallow is deliberate, not a silent bug.
- **R34 (adjacent):** F2 — `--ignore-scripts` skips engine fetch; copy-from-builder keeps CLI/engine consistent.
- **RS1-RS4 / RT1-RT6:** checked, no additional findings beyond the above.

## Resolution Status

Branch: `chore/pin-actions-and-wire-ci-checks`. User chose the comprehensive scope (full supply-chain +
CI wiring). Fixes applied:

### S1/F1/T1 — Actions floating tags — RESOLVED
- Pinned every `uses:` ref to a 40-char SHA + version comment across all 5 workflows (SHAs resolved via
  `gh api repos/<a>/commits/<tag>`): `actions/checkout@de0fac2…# v6.0.2`, `actions/setup-node@48b55a0…# v6.4.0`,
  `actions/upload-artifact@043fb46…# v7.0.1`, `dorny/paths-filter@fbd0ab8…# v4.0.1`,
  `aquasecurity/trivy-action@ed142fd…# v0.36.0`, `github/codeql-action/{init,autobuild,analyze}@7211b7c…# v4.36.0`.
- `release.yml`: also pinned the previously-floating `npm install -g npm@latest` → `npm@11.12.1` (this job
  holds `id-token: write`, so an unpinned npm was a path to the OIDC publish token) — R34 adjacent.
- Verified: `scripts/checks/check-actions-sha-pinned.sh` now passes.

### S1/T2/T3 — Ungated checks / pre-pr-not-in-CI — RESOLVED (SSoT, no new drift)
- Added `PRE_PR_STATIC_ONLY=1` mode to `scripts/pre-pr.sh` (skips Lint/Test/Build/integration/secret-scan,
  runs all static guards).
- Added a `static-checks` CI job (`ci.yml`) that runs `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` with
  `fetch-depth: 0`. CI and the local hook now share one definition — the gap cannot reopen.
- Wired `check-actions-sha-pinned.sh` into the pre-pr static block (was dead code).

### S2/F2/T4 — Dockerfile unpinned prisma — RESOLVED
- Pinned `Dockerfile:88` install to the lockfile version: `PRISMA_VER=7.8.0` + a build-time fail-closed
  assertion mirroring the tar/picomatch tripwires. Kept `--no-save --ignore-scripts` (behavior-preserving;
  copy-from-builder rejected — it would drop the CLI's transitive `@prisma/engines` etc.).
- Added `scripts/checks/check-dockerfile-prisma-pin.sh` asserting `PRISMA_VER` == lockfile prisma version,
  wired into pre-pr static block (+ CI via static-checks) so it cannot drift.

### S3/F3 — Passkey counter soft-fail — RESOLVED (comment only)
- Behavior kept (intentional, tested by `background-passkey-provider.test.ts:450`). Rewrote the misleading
  comment in `passkey-provider.ts` to state accurately: network failure already returns `{ok:false}`; only
  HTTP errors reach the soft-fail; the cross-session duplicate-counter consequence; that it self-heals; and
  that passwd-sso's own RP tolerates it while external RPs vary.

### Verification (Round 1)
- `check-actions-sha-pinned.sh` → PASS; `check-dockerfile-prisma-pin.sh` → PASS.
- `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` → 27 checks pass, heavy steps correctly skipped.
- All 5 workflow YAMLs parse. `extension` passkey-provider test suite → 54 pass / 0 fail.

## Round 2 — triangulation of the implementation

Three experts reviewed the staged diff. Most of the implementation was confirmed correct & complete
(SHA-pin completeness, pre-pr STATIC_ONLY gating + exit-code propagation, Dockerfile pin scope/path,
prisma-pin check, passkey comment accuracy, OIDC scoping, no fork-secret exposure on the `pull_request`
trigger). Three actionable findings, all fixed:

### F1 — Major (incomplete fix): static-checks job missing `main` ref → diff-vs-main guards fail open — FIXED
- `actions/checkout` with `fetch-depth: 0` fetches history but does NOT create a local `main` branch, so
  `git diff main...HEAD` errored and the diff-based guards (prf-salt-immutable, R35 manual-test gate,
  test-hygiene, e2e-selectors, settings-card-layout) silently passed vacuously in CI.
- Fix: added the `Ensure main ref is available` step (`git fetch origin main:main`) — the exact pattern
  already proven in `refactor-phase-verify.yml`. (`ci.yml`)

### T3 — Minor: redundant `npx prisma generate` in static-checks — FIXED
- Verified every static guard is a pure source/schema grep (e.g. `check-bypass-rls.mjs` imports only
  `node:fs`/`node:path`); none import the generated client, and there is no `postinstall`. Removed the step.

### T6 — Major (adjacent): misleading secret-scan comment — FIXED
- The skip message claimed "CI scans the full history elsewhere," but no secret-scan CI job exists. Reworded
  to state accurately that the gitleaks `--staged` scan is a local pre-push check (nothing is staged in CI).
- NOTE (deferred, user decision): CI has **no** secret-scanning job. This is pre-existing (gitleaks was only
  ever in the local hook). Adding one (gitleaks-action full-history, or relying on GitHub push protection)
  is an optional follow-up, out of this PR's agreed scope.

### S2 — Informational (deferred, pre-existing in changed file): tar/picomatch assertions use JS `<`
- The pre-existing tar/picomatch build-time assertions (`Dockerfile`, not introduced here) compare versions
  with lexicographic `node -e "... v < VER"`. **Anti-Deferral:** Worst case = a future newer version
  false-fails the build (fail-CLOSED, never fail-open → no security risk); Likelihood = low (pinned
  versions); Cost-to-fix = low but orthogonal to this PR's CVE-patch logic. The new prisma assertion
  correctly uses exact `!==`. Deferred as `TODO(dockerfile-version-cmp): use semver-correct compare in
  tar/picomatch assertions`.

### Verification (Round 2)
- `ci.yml` parses; `static-checks` steps = checkout → setup-node → npm ci → Ensure main ref → static guards.
- `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` → 27 pass; both new guards pass.
- Round 2 converged — no new findings beyond the three fixed (all within Round-1 fix scope). NOT committed.
