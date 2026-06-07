# Plan: directory-structure-review

> Whole-repo directory-structure review covering `scripts/` **and** `src/`.
> Successor to the `scripts/` reorg that was **dropped** in PR #519
> (`feature/dev-ops-tooling`). See `docs/archive/review/dev-ops-tooling-review.md`
> for that drop decision. This plan re-evaluates each pin file-by-file per the
> user's note that "当時と今とで状況が違う" — but every pin is treated as
> currently load-bearing until proven otherwise with evidence.

## Project context

- **Type**: web app (Next.js 16 App Router) + CLI + extension monorepo-ish tree
- **Test infrastructure**: unit (vitest) + integration (real-DB vitest) + E2E
  (Playwright) + CI/CD (GitHub Actions) + a large bespoke `scripts/checks/**`
  static-gate suite + a documented **Refactor Workflow** (phase-config codemod
  + `refactor-phase-verify.mjs`).
- **Verification environment constraints**:
  - `VEC1` — `refactor-phase-verify.mjs` parallel-branch guard requires **only one
    open `refactor/*` PR at a time** (`gh pr list` filtered to `refactor/`). Move
    phases (B, C) MUST therefore ship as **sequential** PRs, not concurrent.
    Classification: `verifiable-local` (the guard runs in `pre-pr.sh` and CI).
  - `VEC2` — `.refactor-phase-verify-baseline` fails the run if `origin/main`
    advanced since the baseline was recorded ("Rebase and re-run"). Each move
    phase must rebase on the latest main immediately before running the gate.
    Classification: `verifiable-local`.
  - `VEC3` — integration tests (`npm run test:integration`) need a live Postgres.
    **Corrected (review T5)**: C6 relocates tests **into** `src/lib/auth/session/`
    and `src/lib/vault/`, both of which match `ci-integration.yml` path filters
    (`'src/lib/auth/**'`, `'src/lib/vault/**'`). The Phase C PR therefore **does**
    trigger the live-Postgres integration suite. The relocated files are unit
    tests (they do not themselves touch the DB), but the gate fires and must pass.
    Run `npm run test:integration` locally before the Phase C PR (start
    `docker compose ... up -d db`), or rely on `ci-integration.yml` as the
    authoritative gate. C4 (`src/lib/generator/`) does NOT match the integration
    filter. Classification: `verifiable-CI` (+ `verifiable-local` preview).
  - `VEC4` — the `.git-blame-ignore-revs` move-commit SHA is self-referential
    (the SHA of the commit being created). Resolved by the documented
    commit→`rev-parse`→`--amend` cycle **before push** (amending a pushed commit
    is forbidden per project convention). Classification: `verifiable-local`.

## Objective

1. **Truth-up the Directory Policy**: bring `CONTRIBUTING.md`'s pin lists and
   `.github/CODEOWNERS` into agreement with the *actual* coupling discovered in
   the diagnosis — the policy has drifted (several de-facto pins are
   undocumented; three pin *reasons* are inaccurate; several genuine security
   boundaries are un-gated). **Zero file moves.**
2. **Execute the small set of genuinely safe, valuable moves** that the
   file-by-file re-validation surfaced — as move-only PRs through the existing
   Refactor Workflow, each amending policy in the same commit as the move.
3. **Test hygiene**: remove a provable duplicate test and co-locate orphan
   test files with their targets.

Out of scope (see Scope contract): any `scripts/` root reorg, src/lib loose-file
clustering, and `docs/archive/**` path rewrites.

## Diagnosis summary (evidence base)

Three read-only diagnostic sweeps (scripts/ pins, src/lib pins, blast-radius)
established:

- **scripts/ root is overwhelmingly load-bearing.** Of ~44 root files, only 5
  have *no* mechanical coupling (`audit-anchor-publisher.ts`,
  `set-audit-anchor-publisher-password.sh`, `migrate-webhook-secrets-v1-to-v2.ts`,
  `regenerate-account-token-legacy-fixture.ts`, `coverage-diff.mjs`). The #519
  conclusion ("scripts/ root is intentionally fixed") **still holds**.
- **Policy ↔ reality drift** (the real debt):
  - *De-facto pins missing from `CONTRIBUTING.md`*: `dcr-cleanup-worker.ts`
    (Docker+npm+test, identical coupling to the documented `audit-outbox-worker.ts`),
    `audit-chain-verify-worker.ts` (`package.json:44`), the six `rls-cross-tenant-*`
    fixtures (`ci.yml:553-566`, `pre-pr.sh:151-152`), `check-state-mutation-centralization.{sh,ts}`
    (`ci.yml:228`, test `resolve()`), `migrate-prf-per-credential-salt.sh`
    (`pre-pr.sh:178` integrity check — **moving it would silently bypass a security
    invariant**), `env-descriptions.ts` (`ci.yml:65` + relative imports),
    `env-allowlist.ts` (CODEOWNERS-gated but not in the CONTRIBUTING list),
    `scripts/lib/*` (`pre-pr.sh:398` hardcodes `scripts/lib/hex-leak-scan.mjs`).
  - *Inaccurate src/lib pin reasons*: `password-generator.ts` ("single-instance"
    — actually a stateless pure module; the weakest pin) and `load-env.ts`
    ("bootstrap-sensitive" — really **6** *out-of-src* importers via the
    `@/lib/load-env` alias). **Correction (review F2)**: `notification.ts`'s
    "RLS-allowlisted" reason is *accurate* — it is named in
    `scripts/checks/check-bypass-rls.mjs:67` (CI-gated RLS-bypass allowlist); the
    original diagnostic claim "no allowlist references it" was wrong. C2 only
    *augments* that reason, it does not replace it.
  - *Un-gated genuine security boundaries* in CODEOWNERS: `prisma.ts` (495
    importers, RLS-aware proxy singleton), `webhook-dispatcher.ts` (HMAC signing,
    SSRF mitigation), `env.ts` (startup validation).
- **src/ test hygiene**: `src/lib/__tests__/prisma-filters.test.ts` (504 B) is a
  near-duplicate of the canonical `src/lib/prisma/prisma-filters.test.ts` (669 B);
  4 orphan test files sit at `src/lib/` root testing subdir targets.

## Technical approach

- **Refactor tooling contract** (verified by reading the scripts):
  - `verify-move-only-diff.mjs` inspects **only R/C renames** from
    `git diff --name-status -M main` (filtered by `--glob src/**`); it ignores
    M/A/D. → content edits to `CONTRIBUTING.md`, `CODEOWNERS`, `package.json`,
    rewritten importers are **invisible** to it.
  - `check-blame-ignore-revs.mjs` `ALLOWED_MA_PATHS` explicitly includes
    `CONTRIBUTING.md`, `.github/CODEOWNERS`, `vitest.config.ts`, `package.json`,
    `src/**`, `docs/**`. → a move-only PR **may** edit policy files in the same
    commit. This is what makes the mandate "amend policy in the same commit as the
    move" technically valid.
  - The codemod `move-and-rewrite-imports.mjs` auto-rewrites: all `src/scripts/e2e`
    files (alias + relative imports), `check-bypass-rls.mjs`,
    `check-crypto-domains.mjs`, `vitest.config.ts`, and `.github/workflows/*.yml`.
    It does **NOT** touch `CONTRIBUTING.md`, `CODEOWNERS`, `package.json`,
    `README*`, `CLAUDE.md`, `.git-blame-ignore-revs` — those are manual same-commit
    edits.
  - `--check-test-pairs` requires that a moved impl file's sibling `*.test.ts(x)`
    (if present on disk) is also in `moves[]`.
- **Phasing by risk** (lowest first), each its own PR:
  - **Phase A** = policy truth-up (no moves) → `docs/*` branch, does **not** trip
    the `refactor/*` parallel guard.
  - **Phase B**, **Phase C** = move-only PRs on `refactor/*` branches, run
    sequentially (VEC1).
- **Same-commit policy amendment** for moves: Phase B removes
  `password-generator.ts` from the CONTRIBUTING pin list in the move commit.

## Contracts

### C1 — CONTRIBUTING.md scripts pin-list truth-up (Phase A, no move)

- **Change**: extend `CONTRIBUTING.md` §"Root-of-`scripts/` fixed" so the
  documented pin list matches the de-facto pins discovered in diagnosis. Add:
  - Runtime entrypoints: `dcr-cleanup-worker.ts`, `audit-chain-verify-worker.ts`
    (alongside the existing `audit-outbox-worker.ts`), with their coupling cited.
  - Operator scripts: `set-dcr-cleanup-worker-password.sh` (review F3 — peer of
    the documented `set-outbox-worker-password.sh`; referenced by
    `env-allowlist.ts:171,173` and `scripts/__tests__/set-dcr-cleanup-worker-password.test.mjs`).
  - Data fixtures: broaden the `rls-smoke-*.sql` bullet to also cover
    `rls-cross-tenant-*` (`*.sql`, `*.sh`, `*.manifest`).
  - Static-gate scripts: `check-state-mutation-centralization.{sh,ts}`,
    `migrate-prf-per-credential-salt.sh` (note: pinned by the `pre-pr.sh`
    integrity check), `env-descriptions.ts`, `env-allowlist.ts`, `scripts/lib/*`.
- **Optional hardening (review S3)**: `scripts/pre-pr.sh:179-181` silently passes
  (`echo "OK (script not present yet)"; exit 0`) when
  `migrate-prf-per-credential-salt.sh` is absent — so a future move would *silently*
  disable the PRF read-only integrity check. The "not present yet" justification is
  stale (the script exists and is load-bearing). Harden the missing-file branch to
  `exit 1` with a "move it back or update this gate" message. This is a behavior
  change to a CODEOWNERS-gated file (rides in the Phase A PR); include only with
  reviewer/owner sign-off since it changes a gate's failure mode.
- **Invariant** (app-enforced via review, schema-enforced N/A): every file named
  in the pin list has a *current* coupling line cited (file:line); every script
  the diagnosis found mechanically coupled appears in the list OR is explicitly
  exempted.
- **Forbidden patterns**:
  - `pattern: password-generator.ts` in C1's CONTRIBUTING diff — reason: C1 must
    not touch the password-generator line; that line is owned by C4.
- **Acceptance**: `npm run check:env-docs` and `scripts/checks/check-doc-paths.mjs`
  (if applicable) pass; a reviewer can trace each new pin entry to a real
  coupling. No file content other than `CONTRIBUTING.md` changes.

### C2 — CONTRIBUTING.md src/lib pin-reason correction (Phase A, no move)

- **Change**: correct/augment the pin reasons in the §"Root-of-`src/lib/` pinned"
  table:
  - `notification.ts`: **augment** (do NOT replace) "RLS-allowlisted" — it is
    accurate (named in `scripts/checks/check-bypass-rls.mjs:67`, CI-gated). New
    text: "Named in `check-bypass-rls.mjs` RLS-bypass allowlist (CI-gated); 19
    importers via `@/lib/notification`." (Review F2 reversed the original
    diagnostic claim; the codemod's `rewriteAllowlistFile` would update line 67
    automatically if it ever moved, but the file is not moved by this plan.)
  - `load-env.ts`: replace "Bootstrap-sequence-sensitive" with the accurate
    reason (**6** *out-of-src* importers — `e2e/global-setup.ts`,
    `e2e/global-teardown.ts`, and 4 `scripts/*` files: `audit-anchor-publisher.ts`,
    `audit-outbox-worker.ts`, `dcr-cleanup-worker.ts`,
    `migrate-account-tokens-to-encrypted.ts` — depend on the `@/lib/load-env`
    alias path; review F4 said 7 but `generate-env-example.ts` only mentions it in
    a comment string, not an import — verified count is 6).
- **Invariant**: `password-generator.ts` row is **left untouched** in C2 (owned by
  C4). The pinned-file *count* in the section header ("10 files") is updated only
  by C4 when the file moves out.
- **Forbidden patterns**: `pattern: password-generator` in C2's diff — reason:
  owned by C4.
- **Acceptance**: the two corrected reasons are factually verifiable against the
  cited evidence; no other table rows change.

### C3 — CODEOWNERS selective security-gate additions (Phase A, no move)

- **Change**: add CODEOWNERS rules for the genuine security boundaries the
  diagnosis found un-gated (user decision: "high-risk only, selective"). The
  review (S2, S4) surfaced two enforcement-layer directories the initial
  diagnosis missed — both are unambiguously high-risk and are included:
  - `/src/lib/prisma.ts @ngc-shj` — RLS-aware Prisma proxy singleton (495 importers)
  - `/src/lib/webhook-dispatcher.ts @ngc-shj` — HMAC signing + SSRF mitigation
  - `/src/lib/env.ts @ngc-shj` — startup env validation
  - `/src/lib/proxy/** @ngc-shj` — **(review S2)** the active CSRF / session /
    CORS / security-header enforcement layer (`csrf-gate.ts`, `auth-gate.ts`,
    `cors-gate.ts`, `security-headers.ts`, `route-policy.ts`, `api-route.ts`) —
    the architectural centerpiece that closes the baseline-CSRF gap (CLAUDE.md).
    At least as critical as `webhook-dispatcher.ts`.
  - `/src/lib/security/** @ngc-shj` — **(review S4)** rate limiting
    (`rate-limit*.ts`, `ip-rate-limit.ts`), CSP construction (`csp-builder.ts`),
    redirect safety (`safe-href.ts`), password policy, Sentry scrubbing.
- **Self-protecting gate (review S1, mandatory)**: each new CODEOWNERS path MUST
  also be added to `ROSTER_GLOBS` in `scripts/check-codeowners-drift.mjs:29-61`
  (which currently lists `scripts/env-allowlist.ts`, `src/lib/auth/**`, etc.).
  Without this, a future PR could silently delete the new gate and the drift check
  would not catch it. That file is itself gated under `/scripts/**`, so the edit
  rides in the same Phase A PR.
- **Naming-collision note (review N1)**: `src/lib/proxy/security-headers.ts`
  (runtime CSP/HSTS application) and `src/lib/security/security-headers.ts` (builder
  helpers) are two distinct files with the same basename; both new globs gate them
  to the same owner, so there is no ownership ambiguity — but a contributor could
  edit the wrong one. Intentional; flagged so reviewers know both are distinct.
- **Invariant**: only genuine security boundaries are gated. Frequently-touched
  non-boundary files (`notification.ts`, `redis.ts`) and broader constant subtrees
  are **deferred** (see SC4) to avoid merge friction. `env-schema.ts` and
  `constants/audit/**` remain **expert-decision candidates** — include only if a
  reviewer makes the security case; default is to leave them out.
- **Forbidden patterns**:
  - `pattern: ^/src/lib/notification.ts` — reason: SC4, deferred to avoid friction.
  - `pattern: ^/src/lib/redis.ts` — reason: SC4, deferred.
- **Acceptance**: `scripts/check-codeowners-drift.mjs` passes; each new rule names
  an owner AND has a matching `ROSTER_GLOBS` entry (verify by adding a temporary
  bad path and confirming the drift check fails, then revert); CI
  `version-check`/lint unaffected.

### C4 — Move `password-generator.ts` → `src/lib/generator/` (Phase B, move-only)

- **Change**: relocate the weakest-pinned src/lib root file into the existing
  `src/lib/generator/` subdir, with its test sibling:
  - `moves[]`: `src/lib/password-generator.ts` → `src/lib/generator/password-generator.ts`;
    `src/lib/password-generator.test.ts` → `src/lib/generator/password-generator.test.ts`.
  - Codemod auto-rewrites: the 1 importer
    (`src/app/api/passwords/generate/route.ts`, `@/lib/password-generator` →
    `@/lib/generator/password-generator`), the file's own relative imports
    (`./generator/generator-prefs` → `./generator-prefs`; `./format/wordlist` →
    `../format/wordlist`), and `vitest.config.ts:29` coverage path.
  - **Manual same-commit edits**: remove the `password-generator.ts` row from the
    `CONTRIBUTING.md` §"Root-of-`src/lib/` pinned" table and update the "(10 files)"
    count to "(9 files)"; update `CLAUDE.md:455` (`src/lib/password-generator.ts`
    → `src/lib/generator/password-generator.ts`, review F5 — `CLAUDE.md` is in
    `check-blame-ignore-revs` `ALLOWED_MA_PATHS`, so same-commit edit is allowed);
    append the move-commit SHA to `.git-blame-ignore-revs` (VEC4 amend cycle).
- **Consumer-flow walkthrough**:
  - Consumer `passwords/generate route` (path:
    `src/app/api/passwords/generate/route.ts`) imports
    `generatePassword`/exports from `@/lib/password-generator` and calls it
    server-side; after the move it reads from `@/lib/generator/password-generator`
    — the codemod rewrites the single import line. No field-shape change; the
    module's public API is unchanged.
  - Consumer `vitest coverage config` (path: `vitest.config.ts`) lists the source
    path in `coverage.include`; codemod rewrites the literal. Verify the new path
    appears post-move (`check-vitest-coverage-include.mjs --enforce-rename-parity`
    is gate #7).
  - Consumer `CLAUDE.md` (path: `CLAUDE.md:455`, documentation) names the file
    path in prose (review F6). NOT auto-rewritten by the codemod → manual
    same-commit edit (see above). No runtime impact, but the forbidden-pattern
    grep below would not catch a doc-format mention, so it is enumerated here.
- **Invariants**:
  - app-enforced: `password-generator.ts`'s public exports are byte-identical
    pre/post move (`verify-move-only-diff --glob src/**` strips imports and
    compares bodies → must pass).
  - The `generator/` subdir gains the file as a **sibling**, not as `index.ts`
    (the dir already holds `generator-prefs.ts`, `generator-summary.ts` and has no
    index).
- **Forbidden patterns**:
  - `pattern: @/lib/password-generator(?!/)` anywhere in `src/` after the move —
    reason: stale alias; all importers must point at `@/lib/generator/password-generator`.
  - `pattern: ` (non-move content edit to any file outside the codemod's
    auto-rewrite set + the manual same-commit set) — reason: move-only PR.
- **Acceptance**: `refactor-phase-verify.mjs --force` green (all 16 checks);
  `npx vitest run` green; `npx next build` green; `CONTRIBUTING.md` no longer
  lists `password-generator.ts`; `.git-blame-ignore-revs` carries the move SHA
  (R100).

### C5 — Remove duplicate `prisma-filters.test.ts` (Phase C, delete)

- **Change**: delete `src/lib/__tests__/prisma-filters.test.ts` (504 B) **iff** it
  is provably redundant against the canonical `src/lib/prisma/prisma-filters.test.ts`
  (669 B) — i.e. every behavioral assertion in the smaller file is covered by the
  larger one.
- **Invariant (verify-before-delete)**: the comparison method is **assertion-by-
  assertion**, not coverage-delta (review T6 — two identical assertions produce the
  same delta whether or not one is present). List every `it(...)` description +
  assertion in the smaller file and confirm each has a semantically equivalent one
  in the canonical. If the smaller file asserts anything the canonical does not,
  **do not delete** — fold the missing assertion into the canonical first. This is
  a delete (D) under `src/**` (allowed by `check-blame-ignore-revs`).
- **Review T6 determination (verified)**: the smaller file's 3 assertions
  (`deletedAt === null`, `isArchived === false`, `keys length === 2`) are *fully*
  covered by the canonical, which adds a `toStrictEqual` shape check. **Deletion is
  SAFE.** Re-confirm at implementation time (the file may change before the PR).
- **Forbidden patterns**: none mechanical; this is a human-verification gate.
- **Acceptance**: the assertion-by-assertion list is recorded in the PR; `npx
  vitest run` green; `@/lib/prisma/prisma-filters` coverage not reduced.

### C6 — Co-locate orphan src/lib root test files (Phase C, move-only)

- **Change**: relocate 3 orphan tests next to their targets (no impl sibling at
  the FROM location, so `--check-test-pairs` is satisfied moving the test alone):
  - `src/lib/callback-url-basepath.test.ts` → `src/lib/auth/session/callback-url-basepath.test.ts`
    (target `src/lib/auth/session/callback-url.ts` exists).
  - `src/lib/vault-unlock-error.test.ts` → `src/lib/vault/vault-unlock-error.test.ts`.
  - `src/lib/vault-context-loading-timeout.test.tsx` → `src/lib/vault/vault-context-loading-timeout.test.tsx`.
- **MANDATORY pre-move step (review F1/T1/T2 — Critical)**: the codemod
  `move-and-rewrite-imports.mjs` rewrites only `ImportDeclaration` /
  `ExportDeclaration` nodes inside moved files — it does **NOT** rewrite relative
  `vi.mock("./…")` call expressions in a moved file. After the move those
  specifiers resolve to non-existent siblings, so the mock silently stops
  intercepting (false-green; the test passes against the real implementation or
  errors on a browser-only import in node). Before running the codemod, **convert
  every relative `vi.mock("./…")` in the two affected files to its `@/lib/…` alias
  form** (alias mocks work from any location and are not moved modules):
  - `src/lib/callback-url-basepath.test.ts:8`: `vi.mock("./url-helpers", …)` →
    `vi.mock("@/lib/url-helpers", …)` (canonical alias already used in
    `vault-unlock-error.test.ts:4`).
  - `src/lib/vault-context-loading-timeout.test.tsx:36-46`: the **authoritative**
    rewrite (each alias DERIVED from `vault-context.tsx`'s real import, round-2
    verified — do NOT guess from the test's relative string, which is already wrong
    for 4 of them):
    - `./crypto-client` → `@/lib/crypto/crypto-client`
    - `./crypto-team` → `@/lib/crypto/crypto-team`
    - `./webauthn-client` → `@/lib/auth/webauthn/webauthn-client` (NOT
      `@/lib/webauthn-client` — the module is two dirs deep)
    - `./team/team-vault-context` → `@/lib/team/team-vault-context`
    - `./vault/auto-lock-context` → `@/lib/vault/auto-lock-context`
    - `./emergency-access/emergency-access-context` → `@/lib/emergency-access/emergency-access-context`
    - `./crypto-emergency` → **DELETE this mock** — `vault-context.tsx` does NOT
      import `crypto-emergency` (verified), so the mock is dead (mocks a module the
      subject never loads) regardless of path. Do not alias a dead mock.
    - **Pre-existing-condition note**: the first four relative mocks
      (`./crypto-client`, `./crypto-emergency`, `./crypto-team`,
      `./webauthn-client`) already resolve to non-existent `src/lib/*` paths from
      the test's current root location, so they do **not** intercept today. The
      alias conversion therefore *fixes* latent dead mocks (improving correctness),
      not merely preserves behavior — which is exactly why the strengthened
      per-file `--reporter=verbose` verification below is mandatory.
  This pre-edit is a **content change**, so it must land in a **separate prep
  commit BEFORE** the move commit (the move commit must stay move-only for
  `verify-move-only-diff`), or — cleaner — in its own tiny prep PR merged ahead of
  Phase C. `vault-unlock-error.test.ts` already uses an alias mock → no change.
- **Invariant**: `vitest.config.ts` `include` uses `src/**/*.test.{ts,tsx}`
  (recursive) — confirm before moving so relocated tests still run. The codemod
  rewrites the relative *imports* (not mocks) inside each moved test.
- **Note (CODEOWNERS)**: `callback-url-basepath.test.ts` moves *into*
  `src/lib/auth/**`, a CODEOWNERS-gated path. `check-codeowners-drift.mjs` passes
  because `src/lib/auth/**` already owns the new location; no CODEOWNERS edit
  needed.
- **Forbidden patterns**:
  - `pattern: vi\.mock\("\./` in any moved test file (post-prep) — reason: relative
    mocks break on move; must be `@/lib/` alias form.
  - `pattern: ` (non-move content edit outside codemod auto-rewrite set, in the
    move commit) — reason: move-only PR.
- **Acceptance (strengthened, review T4)**: `refactor-phase-verify.mjs --force`
  green; `npx vitest run` green; **plus** per-file
  `npx vitest run <relocated-test> --reporter=verbose` confirming each mock
  intercepts (for `callback-url-basepath.test.ts`, add an in-body assertion that
  `BASE_PATH === "/passwd-sso"` so a non-intercepting mock fails loudly rather than
  passing false-green); confirm the Phase C PR's `ci-integration.yml` run is green
  (VEC3).

### C7 — Investigate `src/lib/validations.test.ts` (Phase C, investigate-only)

- **Change**: determine the relationship between the root
  `src/lib/validations.test.ts` (16.7 KB, Apr 5) and
  `src/lib/validations/validations.test.ts` (42.8 KB, Jun 1). These are NOT
  obviously a pure duplicate (different sizes, the subdir one is far larger and
  newer).
- **Invariant (defer-unless-proven)**: do **not** delete or move the root file
  unless analysis proves it is fully redundant (every assertion covered by the
  subdir file). If it carries unique assertions, **leave it in place** and record
  the finding; relocation/merge becomes a tracked follow-up, not part of this PR.
- **Review T7 determination (verified)**: root `src/lib/validations.test.ts` is
  **NOT redundant**. It holds unique assertions absent from
  `src/lib/validations/validations.test.ts`: `createE2EPasswordSchema` aadVersion
  defaults/out-of-range/negative (lines ~90-137), `updateE2EPasswordSchema`
  aadVersion=1/=2 (~152-173), and `createShareLinkSchema` passkey fields
  (relyingPartyId/credentialId/deviceInfo + max-length, ~175-230). **Outcome: leave
  in place.** Folding the unique assertions into the subdir file + deleting the root
  is a tracked follow-up: `TODO(directory-structure-review): merge unique
  validations.test.ts assertions into validations/validations.test.ts`.
- **Acceptance**: the written determination above is recorded; no deletion in this
  plan. No silent loss of test coverage.

## Testing strategy

- **Phase A** (C1-C3, no moves): run `npm run check:env-docs`,
  `npx eslint`/`npm run lint` on changed config, and `scripts/pre-pr.sh`
  static-only (`PRE_PR_STATIC_ONLY=1`). `check-codeowners-drift.mjs` must pass.
  Skip `npx next build` if only docs/CODEOWNERS change (per the user's
  test-only-skip rule) — but run it if any executable config is touched.
- **Phase B / C** (moves): for each, `--check-test-pairs` → codemod →
  `refactor-phase-verify.mjs --force` (16 checks) → `npx vitest run` →
  `npx next build`. Rebase on latest main first (VEC2).
- **Regression for C4/C6**: the relocated tests are themselves the regression
  proof — they must execute from the new path and pass.

## Considerations & constraints

- **Mandate**: policy (`CONTRIBUTING.md`, `CODEOWNERS`) changes that accompany a
  move ride in the **same commit** as that move (C4). Standalone policy truth-up
  with no move is Phase A.
- **PR cadence**: this plan intentionally uses **per-phase PRs** (C1-C3 = PR A;
  C4 = PR B; C5-C7 = PR C), overriding the usual "one aggregate PR" preference,
  because (a) the user explicitly asked for "フェーズごとの move-only PR", and
  (b) `verify-move-only-diff` requires each move PR to be move-only — bundling
  policy-only edits and multiple unrelated move sets would defeat the move-only
  gate and the parallel-branch guard.
- **Sequencing**: PR A (docs) may overlap with a move PR (different branch
  prefix), but PR B and PR C must not be open simultaneously (VEC1). Recommended
  order: A → B → C.

### Scope contract

- **SC1** — `scripts/` root reorganization: **OUT**. Re-confirmed load-bearing by
  file-by-file diagnosis; the #519 drop decision stands. Owner: none (closed).
- **SC2** — src/lib loose-file clustering (`utils.ts`, `locale.ts`, `events.ts`,
  `safe-keys.ts`, `translation-types.ts`, etc. into purpose dirs): **OUT**. User
  chose "truth-up + surgical moves", not the broader clustering option. Owner:
  future directory-structure PR if revisited.
- **SC3** — `docs/archive/**` path rewrites: **OUT**. Historical record; paths are
  intentionally frozen. Owner: none (permanent).
- **SC4** — CODEOWNERS gates for `notification.ts`, `redis.ts`,
  `constants/{team,vault}/**`: **OUT**. User chose high-risk-only gating; these
  add merge friction without a clear security boundary. Owner: future security
  follow-up; tracked as `TODO(directory-structure-review): re-evaluate CODEOWNERS
  gate for notification.ts/redis.ts/constants subtrees`.
- **SC5** — moving the 5 truly-uncoupled scripts (`audit-anchor-publisher.ts`
  et al.) into a `scripts/` subdir: **OUT**. Marginal value; `scripts/` root is a
  documented fixed layout (would need a policy carve-out for negligible benefit).
  Owner: none (closed).

## User operation scenarios

- **Operator running incident-response scripts**: after Phase A, `README.md` and
  `CONTRIBUTING.md` still reference `scripts/purge-history.sh` etc. at the root —
  none of these move; discoverability preserved.
- **Contributor editing `prisma.ts`**: after C3, the change now requires
  `@ngc-shj` review (new CODEOWNERS gate) — intended friction on a security
  boundary.
- **Contributor regenerating the password generator**: after C4,
  `npm run`-style flows are unaffected (the only importer is the API route, auto-
  rewritten); IDE "go to definition" resolves to `src/lib/generator/`.
- **CI on a stale branch**: VEC2 surfaces as "Rebase and re-run" — the contributor
  rebases; no silent pass.

## Go/No-Go Gate

| ID | Subject                                                        | Phase | Status |
|----|---------------------------------------------------------------|-------|--------|
| C1 | CONTRIBUTING scripts pin-list truth-up (+migrate-prf harden)   | A     | locked |
| C2 | CONTRIBUTING src/lib pin-reason correction (notif/load-env)    | A     | locked |
| C3 | CODEOWNERS selective gates (prisma/webhook/env/proxy/security) + ROSTER_GLOBS | A | locked |
| C4 | Move `password-generator.ts` → `src/lib/generator/`           | B     | locked |
| C5 | Remove duplicate `prisma-filters.test.ts` (verified SAFE)      | C     | locked |
| C6 | Co-locate 3 orphan tests (+ vi.mock alias prep)               | C     | locked |
| C7 | `validations.test.ts` — verified NOT redundant → leave + TODO  | C     | locked |

All contracts are `locked` after two review rounds (round 1: 1 Critical, 5 Major,
4 Minor, 3 Findings — all resolved; round 2: 3 Minor refinements — all resolved).
No remaining open findings. Implementation order: **Phase A → Phase B → Phase C**
(Phase A is a `docs/*` PR not subject to the `refactor/*` parallel guard; B and C
are `refactor/*` move-only PRs that must not be open simultaneously, VEC1).
