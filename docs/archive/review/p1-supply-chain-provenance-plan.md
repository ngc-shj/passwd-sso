# Plan: P1 Supply-Chain Hardening (roadmap C-P1, ship-today scope)

## Project context

- Type: `mixed` — Next.js 16 web app + CLI (npm, `passwd-sso-cli`) + browser extension + iOS (xcodegen) + a large `scripts/checks/*` CI static-guard suite.
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest, real-DB integration, Playwright, XCTest, `scripts/checks/*` guards + `scripts/pre-pr.sh`).
- Verification environment constraints:
  - **VC1**: npm OIDC Trusted Publishing provenance generation happens only on the GitHub Actions release runner (keyless OIDC). It CANNOT be exercised from a local dev machine or a PR CI job → provenance-emission is `verifiable-CI` on the release path only, and in practice already proven by the live registry state (see GT-1). The regression this plan guards is a *future* config drift, observable only at the next release.
  - **VC2**: `npm audit signatures` verifies signatures/attestations of packages **as published to the npm registry**, using the working-tree lockfile to know *which* versions to check. It verifies our own package's provenance only for **already-published** versions, never the unpublished working-tree HEAD. So the CI verifier asserts "every dependency (and our last-published self) has a valid registry signature/attestation," NOT "this PR's HEAD build carries provenance." → `verifiable-CI` and `verifiable-local` (runs against public registry; no secret needed).

## Ground-truth reconciliation (verified against the repo + live npm registry before planning)

- **GT-1 (overturns roadmap-review C1)**: `passwd-sso-cli@0.4.70` on the npm registry **already carries full SLSA provenance**. Measured:
  - `dist.attestations.provenance.predicateType = "https://slsa.dev/provenance/v1"` (SLSA build provenance) AND a `https://github.com/npm/attestation/.../publish/v0.1` npm publish attestation, both in a Sigstore bundle with a Rekor transparency-log entry.
  - `npm audit signatures` (run in `cli/`) reports "verified registry signatures" + "verified attestations".
  - Cause: `release.yml:63-65` runs a bare `npm publish` under **OIDC Trusted Publishing** with npm 11.12.1 (`release.yml:47`). npm ≥ 11.5.1 auto-generates SLSA provenance server-side when publishing via OIDC — no `--provenance` flag needed. **So roadmap-review finding C1's premise ("ships with no provenance today; cosign is needed") is false.** The producer already exists and works. This plan does NOT add a producer; it (A′) pins the behavior against drift + adds the missing *verifier*, (B) extends dependency monitoring, (C) adds a crypto/auth sensitive-dep manifest.
- **GT-2 (Actions boundary already hardened — no work)**: every workflow has an explicit top-level `permissions:` (baseline `contents: read`; only `codeql.yml`/`release.yml` grant any write, and `release.yml` narrows `id-token: write` to the `publish-cli` job). Actions are 40-hex SHA-pinned with the `check-actions-sha-pinned.sh` guard (wired via `pre-pr.sh:169` → `ci.yml` static-checks). `.github/CODEOWNERS:39` gates `/.github/workflows/`. No `pull_request_target` / `workflow_run` anywhere. `SHARE_MASTER_KEY` in `ci.yml`/`ci-integration.yml` is a **public dummy literal**, not a repo secret, and those jobs run on `pull_request` (not `pull_request_target`), so fork PRs never see real secrets. → the roadmap C-P1 "Actions boundary" line is already satisfied; adding redundant guards is out of scope (SC3).
- **GT-3 (Dependabot ecosystem gap)**: `.github/dependabot.yml` covers **only** `github-actions`. `npm` (root, `cli/`, `extension/`) is NOT configured. No auto-merge config exists anywhere (grep of workflows for `dependabot` + `auto.?merge`/`gh pr merge` is empty) — so the M-h "auto-merge fail-open" hazard is currently *absent* and this plan must NOT introduce it.
- **GT-4 (iOS has no Dependabot-supported manifest)**: `ios/` uses **xcodegen** (`ios/project.yml`) with no `Package.swift` (SPM) and no `Podfile` (CocoaPods). Dependabot's `swift` ecosystem requires a `Package.swift`. → iOS is correctly excluded from Dependabot npm/swift scope; recorded as SC1, not an omission.
- **GT-5 (no crypto/auth sensitive-dep manifest)**: `scripts/checks/` has no crypto/auth dependency allowlist (`check-crypto-domains.mjs` is domain-separation, not deps; `check-licenses.mjs` + `scripts/license-allowlist.json` is a *license* allowlist, not a package-criticality list). The closest mirror-able patterns are `check-licenses.mjs`/`license-allowlist.json` (`.mjs` guard + JSON data file, node:fs only, no `@prisma/client`) and `src/__tests__/workers/worker-policy-manifest.test.ts` (filesystem-only parity test with mechanical grep + negative self-test).
- **GT-6 (member-set for the crypto/auth manifest — code-derived, ALL THREE npm workspaces)**: derived by grepping external (non-relative, non-`node:`, non-framework) imports. The scope spans the web app AND the CLI AND the extension — the CLI is the very artifact this roadmap hardens, so omitting its own crypto surface would be a hollow gate (Round-1 M1: Func F1 + Sec SEC-2 convergence). Defining roots per workspace:
  - **root (web app)**: `src/lib/crypto/**`, `src/lib/auth/**`, `src/lib/prisma.ts`, `src/lib/email/**`, `src/auth.ts`, `src/auth.config.ts`, WebAuthn/passkey/SAML route trees, and the TOTP component tree `src/components/passwords/shared/**` (TOTP is a crypto primitive that lives in a component, not under `src/lib/**` — verified: `src/components/passwords/shared/totp-field.tsx:5` imports `otpauth`; a naive `src/lib`-only root would miss it, the exact R-3 blind-spot class). `src/lib/email/**` is included because the magic-link auth channel's SMTP/Resend transports (`nodemailer`, `resend`) carry the session-granting token and are an auth-flow surface — Round-2 SEC-5.
  - **cli**: `cli/src/**`.
  - **extension**: `extension/src/**`.

  Production crypto/auth-sensitive packages (with workspace):
  - `next-auth` (root) — `src/auth.ts`, `src/auth.config.ts`, `src/lib/auth/session/auth-adapter.ts`
  - `@auth/prisma-adapter` (root) — `src/lib/auth/session/auth-adapter.ts`
  - `@simplewebauthn/server` (root) — `src/lib/auth/webauthn/webauthn-server.ts`
  - `@simplewebauthn/types` (root) — webauthn-server + several WebAuthn/passkey routes
  - `hash-wasm` (root) — `src/lib/crypto/crypto-client.ts:149-150` **via dynamic `import(moduleName)`** (a static `from "…"` grep MISSES this — the manifest guard MUST detect the dynamic form)
  - `@prisma/adapter-pg` + `pg` (root, `static-import`) — `src/lib/prisma.ts:2-3`, worker DB clients (the driver-adapter pair the whole auth/session store rides on; `src/lib/prisma.ts` is IN the drift roots so these are statically re-derivable — Round-1 m1 / Round-2 m2: mark `static-import`, NOT `manual`)
  - `@prisma/client` (root, category `db-identity-store`) — pervasive in `src/lib/auth/**`; the ORM for all identity/session/token tables. Classified as a **data-access boundary**, not a crypto primitive (Round-2 m3) — it is in-scope because it is the identity store, and the `db-identity-store` category keeps the taxonomy honest vs. the KDF/signature/OTP primitives.
  - `bcrypt-pbkdf` (cli, `dynamic-import`) — an OpenSSH-key KDF that decrypts encrypted SSH private keys, **via dynamic `import("bcrypt-pbkdf")`** at `cli/src/lib/openssh-key-parser.ts:158` (`const { pbkdf } = await import("bcrypt-pbkdf")`) — same dynamic+KDF shape the manifest catches for hash-wasm (Round-1 M1)
  - `otpauth` (root + cli + extension, `static-import`) — TOTP (2FA shared-secret OTP) generation: `src/components/passwords/shared/totp-field.tsx` (root, `^9.5.0`), `cli/src/lib/totp.ts` (`^9.4.0`), `extension/src/lib/totp.ts` (`^9.5.0`) (Round-1 M1; root occurrence found during member-set re-derivation)
  - `nodemailer` (root, `static-import`, category `auth-flow`) — SMTP transport for the magic-link auth channel, `src/lib/email/smtp-provider.ts:1`; also the NextAuth Nodemailer provider (`src/auth.config.ts:3`). The channel carries the session-granting token (Round-2 SEC-5).
  - `resend` (root, `static-import`, category `auth-flow`) — Resend transport for the same magic-link channel, `src/lib/email/resend-provider.ts:1` (Round-2 SEC-5).
  - **Excluded, with reason (workspace-scoped — Round-2 M1 design principle)**: an exclusion is validated against the specific workspace's code, so "unimported in root" cannot suppress a real import in another workspace. Root exclusions: `ioredis` (session cache transport), `@sentry/nextjs` (error reporting), `bowser` (UA parsing for new-device detection), `zod` (validation), `@noble/hashes` (**test-only** oracle, `*.test.ts`), `@simplewebauthn/browser` (production dep but **not imported anywhere** in `src/` — `webauthn-client.ts:5` is a comment noting the app deliberately uses the raw WebAuthn API instead; **verified absent from `extension/package.json` too** — Round-2 M1 was a false positive on this). cli exclusions: `chalk`, `commander`, `cli-table3` (CLI UX). extension exclusions: `tldts` (public-suffix/domain parsing for autofill origin), `react`/`react-dom` (framework). SAML uses an **out-of-process Jackson** OIDC endpoint — there is no `@boxyhq/saml-jackson` npm dependency. `jose` and native `argon2` are **not used**. The main vault crypto uses native Web Crypto `crypto.subtle` (no npm primitive). The manifest scopes to packages that implement or wrap an auth-flow / KDF / signature / OTP / identity-store primitive; the workspace-scoped exclusions are recorded so a reviewer can contest the boundary per workspace.

## Objective

Land the ship-today slice of roadmap C-P1: make the already-working npm provenance explicit, drift-proof, and fail-closed-at-release; add the missing signature *verifier* (PR jobs + a scheduled sweep); extend dependency monitoring to the npm ecosystems; and add a mechanized crypto/auth sensitive-dependency manifest that reconciles code-imports, package.json, and the manifest across all three npm workspaces (root/cli/extension) — without adding a producer that already exists, without redundant Actions guards, and without an auto-merge fail-open path.

## Requirements

Functional:
- CLI publish continues to emit SLSA provenance, now via an **explicit** `publishConfig.provenance: true` rather than an implicit npm-version-dependent default.
- CI runs `npm audit signatures` so a future regression in dependency signing (or our own once published) is caught.
- Dependabot opens grouped npm update PRs for root, `cli/`, and `extension/`, requiring human review (no auto-merge).
- A CI-checked JSON manifest enumerates crypto/auth-sensitive npm packages across all three npm workspaces (root/cli/extension); a **three-set reconciliation** guard (CODE-derived imports ∪ package.json DEPS ∪ MANIFEST) fails when (A) a new sensitive import is unregistered, (B) a manifest entry vanished from `package.json`, (C) a sensitive `package.json` dep has no code-derived occurrence AND is not a reasoned `detectedBy:["manual"]` entry, or (D) an entry's `reason`/`owners` is empty. It is a **set**-membership gate, deliberately NOT a per-version pin (pinning would force a manifest edit on every routine bump for no supply-chain gain; the value is catching a *new* sensitive dep or a metadata gap), and it correctly accounts for dynamic imports (`hash-wasm`, `bcrypt-pbkdf`).

Non-functional:
- No new runtime code paths; all changes are CI/config/test + one `package.json` field.
- The manifest guard must run in an environment WITHOUT a generated Prisma client (mirror `worker-policy-manifest.test.ts`: filesystem-only, no `@prisma/client` import) — see the `project_static_check_ci_no_prisma_generate` hazard.
- Language policy: code comments English; all else per repo/global rules.

## Technical approach

- **(A′) provenance pin + verifier.** Add `"publishConfig": { "provenance": true }` to `cli/package.json` (explicit, npm-version-independent) + a post-publish attestation assertion in `publish-cli` (INV-C1b). Add `npm audit signatures` to the three existing npm-audit jobs (reusing their `npm ci` trees) plus a weekly `schedule: cron` sweep workflow (M2) so an unchanged-tree tamper is re-verified independent of PRs.
- **(B) Dependabot npm.** Add three `package-ecosystem: "npm"` entries (`/`, `/cli`, `/extension`) to `.github/dependabot.yml`, weekly, grouped, no auto-merge (enforced by a wired `pre-pr.sh` guard, M3). Preserve the existing `github-actions` entry verbatim. Swift excluded (GT-4).
- **(C) crypto/auth sensitive-dep manifest + three-set reconciliation guard.** New data file `scripts/checks/crypto-auth-deps-manifest.json` (object-keyed, member-set from the full GT-6 three-workspace set) + a parity test mirroring `worker-policy-manifest.test.ts` (filesystem-only vitest, ts-morph AST). The guard reconciles CODE-derived imports, package.json DEPS, and MANIFEST per workspace, failing on (A)-(D) above, allowing reasoned `detectedBy:["manual"]` entries for defensive/outside-root deps, with a negative self-test per pure detection function (RT7).

## Contracts

### C1 — `cli/package.json` gains explicit provenance opt-in
- **Change**: add top-level `"publishConfig": { "provenance": true }` to `cli/package.json`. No other key touched.
- **Invariants** (app-enforced — this is config, not schema):
  - INV-C1a: `release.yml` publish step stays a bare `npm publish` under the `publish-cli` job's `id-token: write` (the OIDC path). `publishConfig.provenance` is honored by `npm publish` without a CLI flag. Do NOT add `--provenance` to the command (redundant with the field, and doubles the surface to keep in sync).
  - INV-C1b (m2 — Sec SEC-4/SEC-7): `provenance: true` only *emits* provenance in a supported OIDC context; it fails open if the context degrades (future `id-token` narrowing, npm treating an unsupported context as best-effort). Add a **post-publish attestation assertion** in the `publish-cli` job that fails the release if the just-published version carries no attestation. It MUST be robustly fail-closed (Round-2 SEC-7): prefer running `npm audit signatures` in `cli/` post-publish (the same verifier as C2, which fails closed by design and has registry-retry semantics) rather than a hand-rolled `npm view … | jq`. If `npm view` is used, it must (a) `set -o pipefail`, (b) check `npm view`'s own exit BEFORE the pipe so a registry/network error fails the release rather than being read as "attestation present", (c) positively assert the predicateType (`.dist.attestations.provenance.predicateType == "https://slsa.dev/provenance/v1"`), not mere key presence, (d) retry only on the *absent* signal for registry-propagation lag, never swallowing the definitively-unattested case into success, and (e) never be `|| true`-masked (in the C2 anti-mask grep scope). This converts the R-1 "post-hoc, next-PR" residual into fail-closed-at-release (a cheap subset of SC5, not the permanently-red transitive gate SC5 defers).
- **Forbidden patterns**:
  - `pattern: --provenance` in `.github/workflows/release.yml` — reason: provenance is expressed once, via `publishConfig`; a CLI flag duplicates the contract.
- **Acceptance**:
  - `cli/package.json` parses and contains `publishConfig.provenance === true`.
  - `release.yml` publish command unchanged (still bare `npm publish`), followed by the INV-C1b post-publish attestation assertion.
  - A **concrete named test** (m3 — Test F4), NOT an "or": an `it(...)` block (in the C4 test file or a small dedicated `cli/package.json` shape test) asserting BOTH (i) `cli/package.json` `publishConfig.provenance === true` AND (ii) the `release.yml` `--provenance` forbidden-pattern grep returns zero matches.
  - Consumer-flow: the only consumer of this field is the npm CLI during `release.yml`'s `publish-cli` job. It reads `publishConfig.provenance` and, combined with `id-token: write` OIDC, emits the SLSA provenance attestation. No repo code reads this field. Emission is `verifiable-CI` at the next release (VC1); today's live registry state (GT-1) already demonstrates it works; the INV-C1b assertion makes future emission fail-closed.

### C2 — CI verifies registry signatures/attestations (PR jobs + scheduled sweep)
- **Change**:
  1. Add a `npm audit signatures` step to **all three** npm-audit jobs in `.github/workflows/ci.yml` — `audit-cli` (`working-directory: cli`), `audit-app` (root), `audit-ext` (`working-directory: extension`) — each after that job's existing `npm ci`. (These jobs are `dorny/paths-filter`-gated, so they fire on PRs touching that workspace.)
  2. **Scheduled sweep (M2 — Func F3 + Sec SEC-1 convergence)**: add a small dedicated workflow (e.g. `.github/workflows/dependency-signatures.yml`, `permissions: contents: read`) that runs `npm audit signatures` for all three trees on a weekly `schedule: cron` (and `workflow_dispatch`), independent of code changes. This closes the temporal hole where a registry-side tamper of an already-installed, unchanged dependency would otherwise be re-verified only on the next PR touching that workspace.
- **Invariants**:
  - INV-C2a: the step verifies **registry** signature/attestation state of installed dependencies (and, for our own package, only already-published versions). It MUST NOT assert the working-tree HEAD carries provenance (VC2) — a permanently-red/vacuous assertion.
  - INV-C2b: the step FAILS the job on a real signature verification failure (default `npm audit signatures` exit), sited so a network/registry outage surfaces as an infra failure, not a silent skip (R44 — no exit-masking pipe).
  - INV-C2c (M5 — Test F2): the verifier is only non-vacuous if the trees actually contain signed/attested deps today. Phase 2 MUST record, per tree, that `npm audit signatures` reports ≥1 verified signature/attestation (observed output in the deviation log); if a tree has none, mark that step **known-vacuous** rather than presenting it as an active verifier. Phase 2 MUST also demonstrate the can-fail path once (a corrupted/known-bad signature fixture → non-zero exit) and record the observed red.
- **Forbidden patterns**:
  - `pattern: audit signatures.*\|\| *(true|:)`, `pattern: audit signatures.*; *true`, `pattern: audit signatures.*\|\| *echo` in workflows — reason: masking the verifier's exit defeats it (R44).
- **Acceptance**:
  - `ci.yml` `audit-cli`, `audit-app`, `audit-ext` jobs each contain an un-masked `npm audit signatures` step; each step's exit is the job step's exit (no trailing `|| true`).
  - A scheduled workflow runs the three verifications on a weekly cron with `contents: read`.
  - The anti-mask forbidden-pattern guard (INV-C2b) is wired as a `pre-pr.sh` `run_step` (same M3 wiring discipline as C3) with a negative self-test proving it goes RED on a planted `audit signatures … || true` fixture.
  - Phase 2 deviation log records the per-tree ≥1-signed-dep observation (INV-C2c) and the one-time can-fail demonstration.
  - **Local mirror decision (m3 — Test F5)**: the `npm audit signatures` verifier itself is CI/cron-only, NOT mirrored into `pre-pr.sh`, because it requires network access to the npm registry and would make `pre-pr.sh` fail offline — recorded here as the Anti-Deferral justification rather than left implicit. Only the *masking* grep guard (offline-safe) rides `pre-pr.sh`.

### C3 — Dependabot covers npm ecosystems, no auto-merge
- **Change**: `.github/dependabot.yml` — append three `npm` ecosystem entries (`directory: "/"`, `"/cli"`, `"/extension"`), weekly Monday cadence, grouped, `open-pull-requests-limit` set (e.g. 5). Keep the existing `github-actions` entry.
- **Invariants**:
  - INV-C3a: no auto-merge — no `dependabot` + `gh pr merge`/`auto-merge` workflow is added (M-h fail-open avoidance). Human approval remains required.
  - INV-C3b: no `swift` ecosystem entry (GT-4: no `Package.swift`).
- **Forbidden patterns**:
  - `pattern: dependabot` co-occurring with `gh pr merge` or `--auto` in any `.github/workflows/*.yml` — reason: auto-merging upstream bumps into a password-manager is an RS5/M-h fail-open supply-chain path.
- **Guard wiring (M3 — Sec SEC-3)**: the no-auto-merge check is implemented as a pure function over workflow-file contents in a `scripts/checks/*` guard (or the C4 test file), and is **explicitly added as a `run_step` line in the enumerated `scripts/pre-pr.sh` static block (~line 169)** so it fires in the `static-checks` CI job — an authored-but-unwired guard silently fail-opens. It carries a negative self-test (M5 — Test F3): a synthetic in-memory workflow string containing `dependabot` + `gh pr merge --auto` → violation; a clean string → none.
- **Acceptance**:
  - `dependabot.yml` parses (YAML) and has exactly 4 `updates:` entries: 1 github-actions + 3 npm.
  - Each npm entry has `schedule.interval: weekly`, a `groups:` block, and no auto-merge/rebase-strategy that implies auto-merge.
  - The no-auto-merge guard appears in the `pre-pr.sh` `run_step` list AND fires in `static-checks` CI, AND its negative self-test proves it goes RED on the planted `dependabot`+`--auto` fixture.

### C4 — crypto/auth sensitive-dep manifest + three-set reconciliation guard (all 3 npm workspaces)

**Design principle (user directive, Round-1)**: import scanning is NOT the sole source of truth. A manifest driven only by code-imports misses: dynamic `import()`, `require()`, CLI-only usage, build-script usage, transitively-important deps, and **defensive deps present in `package.json` but not yet imported**. The guard therefore reconciles **three sets** and fails on their disagreements, allowing reasoned manual entries for the code-not-imported case.

The three sets, per workspace:
1. **CODE** — the crypto/auth-sensitive external specifiers derived from source via ts-morph AST (static import + string-literal `import()` + const-resolved `import()` + `require()`), rooted at the GT-6 defining roots.
2. **DEPS** — the `dependencies` (direct) set of that workspace's `package.json`, filtered to crypto/auth-sensitive names by (i) manifest membership and (ii) a **name-pattern heuristic** — an enumerated, self-tested regex set (Round-2 T3): `/crypt|cipher|kdf|pbkdf|bcrypt|scrypt|argon|hash|hmac|sign|jwt|jose|jwk|webauthn|passkey|fido|otp|totp|hotp|nacl|sodium|noble|tweetnacl|oidc|oauth|saml|nodemailer/i`. The heuristic ONLY widens the DEPS side so a crypto-named dep outside the CODE roots still trips (C); it NEVER auto-approves (an entry must still be in `packages` or `excluded`). The pattern list is a `const` in the test with its own negative self-test (crypto-named synthetic → surfaced; plain name → not).
3. **MANIFEST** — the declared `packages` in `crypto-auth-deps-manifest.json`.

- **Change**:
  1. New `scripts/checks/crypto-auth-deps-manifest.json` — shape (user-directed object-keyed structure):
     ```json
     {
       "packages": {
         "@simplewebauthn/server": {
           "workspace": "root",
           "reason": "WebAuthn verification boundary",
           "detectedBy": ["static-import"],
           "owners": ["security"],
           "category": "signature"
         },
         "hash-wasm": {
           "workspace": "root",
           "reason": "Password KDF (Argon2id) implementation",
           "detectedBy": ["dynamic-import"],
           "owners": ["security"],
           "category": "kdf"
         },
         "bcrypt-pbkdf": {
           "workspace": "cli",
           "reason": "OpenSSH private-key KDF",
           "detectedBy": ["dynamic-import"],
           "owners": ["security"],
           "category": "kdf"
         }
       },
       "excluded": {
         "zod": { "reason": "input validation, not a crypto/auth primitive" }
       }
     }
     ```
     - `packages` is keyed by package name. Each value: `{ workspace, reason (**≥10 chars**, mirroring the worker-policy template's `>=10-char` reason floor — Round-2 SEC-6), detectedBy: [ "static-import" | "dynamic-import" | "manual" ], owners: [**≥1, each from a fixed OWNERS enum** validated by the test, e.g. `"security"` — free-text owners rejected, Round-2 SEC-6], category }`. `detectedBy: ["manual"]` is the sanctioned marker for a package present in `package.json` but not imported under the CODE roots (defensive/transitive/build-script) — it satisfies reconciliation (C) without a code occurrence, provided `reason` (≥10 chars) + `owners` (enum) are valid. (`require` dropped from the `detectedBy` enum: verified no `require()` of an external crypto/auth dep exists in any workspace — Round-2 SEC-7; cli/extension have zero bare `require()` and the app is ESM. Re-add only if a CJS crypto import appears.)
     - `excluded` is keyed by package name → `{ reason }`. Seeds: `ioredis`, `@sentry/nextjs`, `bowser`, `zod`, `@noble/hashes` (test-only), `@simplewebauthn/browser` (unimported), plus per-workspace non-crypto deps the CODE scan surfaces (`chalk`/`commander`/`cli-table3` cli; `tldts`/`react`/`react-dom` ext).
     - Member-set of `packages` = full GT-6 three-workspace set (incl. `bcrypt-pbkdf`, `otpauth` in root+cli+ext, the prisma pair as `detectedBy:["manual"]` since they live outside the drift roots — see reconciliation (C) below).
  2. New parity test `src/__tests__/checks/crypto-auth-deps-manifest.test.ts` (filesystem-only, mirrors `worker-policy-manifest.test.ts`), **all detection logic in pure exported functions** (like the template's `classifySweeps`) so each is independently self-testable. It computes the three sets and asserts the four reconciliation failures the user specified:
     - **(A) new sensitive import unregistered**: a specifier in `CODE \ (MANIFEST ∪ excluded)` → finding. (Pure `computeCandidateDrift(code, manifest, excluded)`.)
     - **(B) manifest entry vanished from package.json**: a `MANIFEST` package absent from its workspace `DEPS` → finding. (This is the presence check; a package legitimately removed must be removed from the manifest too.)
     - **(C) sensitive package in package.json but not in CODE-derived set**: a `DEPS`-side crypto/auth-sensitive package (by manifest membership) whose code occurrence is absent → **finding UNLESS the manifest entry carries `detectedBy` including `manual` (or `dynamic-import`/`require` that the scanner then confirms)**. This is the case the user flagged as "not necessarily an error": `@prisma/adapter-pg`/`pg` (imported in `src/lib/prisma.ts`, outside the crypto/auth drift roots) and any defensive dep are represented as `detectedBy:["manual"]` with a reason, satisfying (C) without a drift-root code hit. This resolves Round-1 m1/F2 (the prisma-pair asymmetry) by making the code-not-imported case explicit and reasoned rather than silently list-only.
     - **(D) empty reason or owners**: any `packages` entry with empty `reason` or empty `owners` → finding (metadata completeness).
     - **import-evidence for `detectedBy` accuracy**: for `dynamic-import` members (`hash-wasm`, `bcrypt-pbkdf`), the scanner MUST resolve the `import()` specifier — including the **indirected `const moduleName = "<pkg>"; await import(moduleName)` shape** (recovering the name resolves the `const` binding to its string-literal initializer; net-new logic the template helpers lack → self-tested). For `static-import`, the specifier is found statically. A `detectedBy` claim contradicted by the code (e.g. marked `static-import` but only present dynamically) → finding.
     - **negative self-tests (RT7, INV-C4d)** — for EACH pure function:
       - (A) drift: planted un-manifested specifier → finding; excluded → none; in-manifest → none; `node:`/`@/`/`next`/`react`/relative → dropped.
       - (B) presence (Round-2 T1 — the one gate previously lacking a *unit* negative): a manifest entry absent from a synthetic DEPS set → finding; present in DEPS → none. (Not only the committed-tree mutation — an isolated pure-function negative.)
       - (C) code-not-imported reconciler, ALL THREE branches (Round-2 T2): a `manual`-marked entry with no code hit → NO finding; the same entry WITHOUT `manual` and no code hit → finding; **AND a `dynamic-import`-marked entry that the resolver DOES confirm in code → NO finding, but marked `dynamic-import` with NO confirmable dynamic occurrence → finding** (proving the dynamic-confirmed suppression branch, not just the manual allowance).
       - (D) metadata: empty/`<10-char` `reason` → finding; `owners` empty or containing a value outside the OWNERS enum → finding (Round-2 SEC-6).
       - dynamic resolver: `const x="hash-wasm"; await import(x)` → resolves to `hash-wasm`; `await import("bcrypt-pbkdf")` → resolves to `bcrypt-pbkdf`; dropping either from the manifest → an (A) finding (proving the dynamic member flows through the drift gate, not merely presence).
       - DEPS name-pattern heuristic (Round-2 T3): a synthetic crypto-named dep (matching an enumerated pattern) present in DEPS but absent from CODE and MANIFEST → surfaced by the heuristic → (C) finding; a clearly-non-crypto name → not surfaced. Proves the R-3 backstop can actually fire.
  3. Wire into the normal vitest run (rides `npx vitest run`; NOT the prisma-generate-free static-checks job). ts-morph (`parseRouteSource`) + `node:fs` only — no `@prisma/client` (INV-C4b).
  4. **CODEOWNERS gate on BOTH the manifest AND its enforcing test (Round-2 SEC-6)**: the manifest lives at `scripts/checks/crypto-auth-deps-manifest.json` (already `@ngc-shj`-gated by `.github/CODEOWNERS:15` `/scripts/checks/**`). Add a CODEOWNERS rule gating `/src/__tests__/checks/**` to `@ngc-shj` so the parity test — which holds the reconciliation logic, the name-pattern heuristic, and the manual-allowance acceptance — cannot be weakened without owner review. Gating only the data file is insufficient: an ungated test could shrink the DEPS heuristic or loosen (D), a strictly more powerful bypass than editing the gated manifest.
- **Invariants**:
  - INV-C4a (three-set reconciliation, code-derived, ALL workspaces): the guard reconciles CODE ∪ DEPS ∪ MANIFEST per workspace and fails on failures (A)-(D); a prompt-supplied list cannot silently diverge from either code or package.json for root, cli, AND extension.
  - INV-C4b: the guard imports NO `@prisma/client` (filesystem-only).
  - INV-C4c: dynamic-import members are detected by resolving the `import()` specifier (incl. the indirected `const moduleName` form) to the package name, not by `from "…"`.
  - INV-C4d (RT7): every pure detection function (drift differ, presence, code-not-imported reconciler incl. the dynamic-confirmed branch, metadata-completeness, dynamic-import resolver, DEPS name-pattern heuristic) has ≥1 self-test proving it returns a violation on planted-bad input AND passes on clean input.
  - INV-C4e: the code-not-imported case (C) is NOT auto-failed — a `detectedBy:["manual"]` entry with a ≥10-char `reason` + an enum-valid `owners` is permitted (user directive), so defensive/transitive/outside-root deps are declarable without a forced code occurrence. The bypass is bounded by INV-C4f.
  - INV-C4f (Round-2 SEC-6): both the manifest (`scripts/checks/crypto-auth-deps-manifest.json`) and its enforcing test (`src/__tests__/checks/**`) are CODEOWNERS-gated to `@ngc-shj`, so a `manual` allowance or a heuristic weakening requires owner review — the compensating control that makes the (C) manual-allowance an acceptable residual rather than a silent in-PR self-service bypass.
- **Forbidden patterns**:
  - `pattern: from ['"]@prisma/client['"]` in `crypto-auth-deps-manifest.test.ts` — reason: INV-C4b.
- **Acceptance**:
  - Manifest JSON parses; every `packages` entry has a ≥10-char `reason`, ≥1 enum-valid `owners`, `workspace`, `detectedBy`, `category`; member-set = GT-6 three-workspace set (incl. `nodemailer`, `resend`, `otpauth`×3, `bcrypt-pbkdf`, prisma pair as `static-import`).
  - Reconciliation (A)-(D), import-evidence, the DEPS name-pattern heuristic, and ALL negative self-tests (INV-C4d) pass on the current tree.
  - `.github/CODEOWNERS` gates BOTH `scripts/checks/crypto-auth-deps-manifest.json` (existing) and `src/__tests__/checks/**` (new rule) to `@ngc-shj` (INV-C4f).
  - Removing a manifest package from its `package.json` → (B) RED; a new crypto import without a manifest entry → (A) RED; a `<10-char` reason or a non-enum owner → (D) RED; a non-`manual` entry whose code occurrence is absent → (C) RED; a `dynamic-import` entry the resolver can't confirm → (C) RED — each demonstrated once in Phase 2 (scratch, not committed), recorded in the deviation log.
  - Consumer-flow: consumers are (i) the parity test (reads every field; `workspace` for DEPS selection, `detectedBy` for evidence-mode + the (C) allowances, `reason`/`owners` for (D)) and (ii) a human reviewer / Dependabot triage (reads `reason`/`owners`/`category` for review routing on a bump). Both consumers' required fields are present.

## Testing strategy

- C1: a concrete named `it(...)` (m3) asserting `cli/package.json` `publishConfig.provenance === true` AND the `release.yml` `--provenance` forbidden grep = 0. INV-C1b post-publish attestation assertion is `verifiable-CI` at release (VC1). Emission proven live today by GT-1.
- C2: the `npm audit signatures` step IS its own test in CI (3 PR jobs + 1 weekly cron sweep); the anti-mask grep guard rides `pre-pr.sh` with a negative self-test (RT7). Phase 2 records the per-tree ≥1-signed-dep observation and a one-time can-fail demonstration (INV-C2c). The verifier is `verifiable-local` (network) but deliberately not in `pre-pr.sh` (offline-safety Anti-Deferral).
- C3: YAML-parse + entry-count + no-auto-merge pure-function guard, wired into `pre-pr.sh` `run_step` + `static-checks` CI, with a negative self-test proving it fires on a planted `dependabot`+`--auto` fixture (RT7).
- C4: the three-set reconciliation parity test — failures (A) unregistered import, (B) manifest-vanished-from-package.json, (C) sensitive-in-deps-not-in-code (allowing reasoned `detectedBy:["manual"]`), (D) empty reason/owners — each with its own RT7 negative self-test on a pure exported function, plus the dynamic-import (`const moduleName`) resolver self-test. Prove-it-fails demonstrated in Phase 2 (scratch mutations → RED per failure kind), recorded in the deviation log, not committed.
- **Changes-filter mapping (m3 — Test F7)**: verify `dorny/paths-filter` globs in `ci.yml` route the new files to jobs that actually run — `scripts/checks/crypto-auth-deps-manifest.json` + `src/__tests__/checks/**` map to the filter output that gates the vitest job, and the audit jobs' filters cover the workspaces the C2 steps live in. State the mapping in the deviation log so a supply-chain PR exercises the gates it adds.
- Regression gate: `npx vitest run` (full) + `scripts/pre-pr.sh` (static guards) must stay green. `npx next build` runs because a `package.json` is touched, though no runtime import graph changes (the touched `cli/package.json` is not in the app bundle).

## Considerations & constraints

### Scope contract
- **SC1**: iOS Swift dependency monitoring — deferred. iOS uses xcodegen with no `Package.swift`/`Podfile` (GT-4); Dependabot's swift ecosystem has no manifest to read. Owner: a future PR if/when iOS adopts SPM. Anti-Deferral: adding a swift entry with no manifest is a no-op that Dependabot ignores; cost of a placeholder = confusion, benefit = zero → correctly deferred.
- **SC2**: iOS distribution-artifact provenance (cosign/attestation of the app binary) — deferred. iOS ships via App Store Connect, not a GitHub-Actions-built artifact cosign can sign. Owner: out of the C-P1 npm scope entirely (roadmap SC2).
- **SC3**: Additional GitHub Actions boundary guards (ban-`pull_request_target` guard, third-party action allowlist, `read-all` default) — deferred as **already-satisfied preventive controls** (GT-2). No `pull_request_target`/`workflow_run` exists, permissions are already scoped, actions already SHA-pinned + CODEOWNERS-gated. Anti-Deferral: adding a guard for a pattern that cannot currently occur is a preventive-only control with no present offender; the existing CODEOWNERS gate on `/.github/workflows/` already forces human review of any future `pull_request_target` introduction. Cost of the guard now > benefit (no offender) → deferred, revisit if a fork-triggered workflow is ever added.
- **SC4**: Container-image SBOM/signing (cosign + syft) — deferred (roadmap SC1). No container release path exists in `release.yml` (release-please + npm CLI only); the `ci.yml:593` `docker build … -t passwd-sso:scan` image is ephemeral (Trivy scan only, never pushed). No producer to attach an SBOM/signature to. Owner: a future "containerize release" PR.
- **SC5**: Blanket dependency-provenance *enforcement* (failing CI when any transitive dep lacks provenance) — deferred. Most of the npm ecosystem does not yet emit provenance; a hard gate would be permanently red. C2's `npm audit signatures` verifies signatures that DO exist and fails on tampering, which is the achievable bar today.

### Risks
- **R-1 (npm-version drift, mitigated by C1)**: relying on npm's default-provenance-under-OIDC is version-dependent; a runner npm downgrade could silently drop provenance. `publishConfig.provenance: true` makes it explicit. Residual: if a future npm removes support for the field, the next release's registry state (checked by C2 once published) surfaces it — but only post-hoc. Acceptable: this is a monitoring, not prevention, boundary; recorded here so a reviewer sees the residual.
- **R-2 (C4 boundary subjectivity)**: the auth-flow/kdf/signature/otp vs support-dep line (GT-6 exclusions) is a judgment call. Mitigated by the `excluded[]` block with reasons IN the manifest, so reconciliation (A) is exact and a reviewer can contest a specific exclusion; and by the `owners`/`reason` metadata gate (D) forcing every included entry to carry an accountable owner.
- **R-3 (false-green completeness check — residual)**: the CODE-set is derived per-workspace over defining roots (`src/lib/crypto`, `src/lib/auth`, `src/lib/prisma.ts`, auth entrypoints, WebAuthn/SAML routes, `src/components/passwords/shared/**`; `cli/src/**`; `extension/src/**`). A crypto/auth file added OUTSIDE these roots (e.g. a new `src/components/**` subtree importing a crypto lib) still escapes the CODE side — the same class as any rooted guard. **Residual mitigation via the three-set model**: because reconciliation (C) also flags a crypto/auth-sensitive `package.json` dep with no CODE occurrence (widened by the enumerated, self-tested name-pattern heuristic — Round-2 T3), a genuinely-new dep is caught on the DEPS side even if its file is outside the CODE roots — UNLESS it is name-pattern-invisible to the heuristic. The remaining blind spot is a new crypto dep whose name matches NONE of the heuristic patterns AND whose file is outside the CODE roots; recorded as the known limit. Widening the CODE roots to all of `src/**` was rejected (excessive noise from non-crypto imports); the DEPS-side (C) check with the pattern heuristic is the cheaper backstop, and adding `src/lib/email/**` to the roots (Round-2 SEC-5) shrank the blind spot by moving the magic-link transports onto the CODE side.

## User operation scenarios

- **Release**: maintainer merges the release-please PR → `release.yml` `publish-cli` runs `npm publish` with `publishConfig.provenance: true` under OIDC → registry receives the package + SLSA provenance attestation (as today, now explicit).
- **Dependency bump**: Dependabot opens a weekly grouped npm PR → CI runs (including `npm audit signatures` + the crypto/auth manifest parity test) → maintainer reviews; if the bump touches a crypto/auth-listed package, the `category`/`reason` fields flag it for deeper review; merge is manual (no auto-merge).
- **New crypto dep added by a developer**: developer adds a new signature library under `src/lib/auth/` + to `package.json` → C4 reconciliation (A) goes RED (new import in `CODE \ (MANIFEST ∪ excluded)`) → developer must add a `packages` entry (reason/owners/detectedBy/category) or an `excluded` entry, forcing a supply-chain review at add-time.
- **Defensive/outside-root dep**: developer adds a crypto dep imported only in `src/lib/prisma.ts` (outside CODE roots) or present in `package.json` but not yet imported → reconciliation (C) goes RED UNLESS the entry is marked `detectedBy:["manual"]` with a non-empty reason/owners — the sanctioned path for defensive/transitive/outside-root deps.
- **Manifest drift**: developer removes `hash-wasm` from `package.json` but leaves the manifest entry → reconciliation (B) goes RED. Removing `hash-wasm` from the manifest while it is still imported → (A) goes RED via the dynamic-import resolver.
- **Metadata gap**: a developer adds a `packages` entry with an empty `reason` or `owners` → reconciliation (D) goes RED.

## Implementation Checklist

### Files to modify / create
- **C1**: `cli/package.json` (add `publishConfig.provenance:true`); `.github/workflows/release.yml` (post-publish attestation assertion in `publish-cli`, after `npm publish`).
- **C2**: `.github/workflows/ci.yml` (add `- run: npm audit signatures` to `audit-app`/`audit-ext`/`audit-cli`, each after `npm ci`); NEW `.github/workflows/dependency-signatures.yml` (weekly cron sweep, `contents: read`).
- **C3**: `.github/dependabot.yml` (append 3 npm ecosystem entries); NEW `scripts/checks/check-dependabot-no-automerge.mjs` (pure guard, wired into `pre-pr.sh`).
- **C2 anti-mask guard**: NEW `scripts/checks/check-audit-signatures-unmasked.mjs` (or fold into the dependabot guard as one workflow-lint guard), wired into `pre-pr.sh`.
- **C4**: NEW `scripts/checks/crypto-auth-deps-manifest.json`; NEW `src/__tests__/checks/crypto-auth-deps-manifest.test.ts`; `.github/CODEOWNERS` (add `/src/__tests__/checks/**  @ngc-shj`).

### Reusable patterns (MUST follow)
- audit job step shape: `- run: npm ci` then `- run: npm audit signatures` (mirror `ci.yml:619/641/663`).
- `.mjs` guard shape: `scripts/checks/check-*.mjs` (node:fs, no `@prisma/client`), wired as `run_step "Static: <name>" node scripts/checks/check-*.mjs` in `pre-pr.sh` (mirror `check-team-auth-rls.mjs` at the `run_step` block ~line 185).
- C4 test: mirror `src/__tests__/workers/worker-policy-manifest.test.ts` — `import { parseRouteSource } from "../proxy/ast-guards"`, `ts-morph` `Node`/`SyntaxKind`, `node:fs` `readFileSync`/`readdirSync`, pure exported detection functions + a self-test `describe` block. NO `@prisma/client`.
- SHA-pin any new `uses:` in the cron workflow (guard `check-actions-sha-pinned.sh` enforces).

### CI parity
- `app` paths-filter includes `src/**` + `scripts/**` (`ci.yml:37,48`) → the new manifest JSON + `src/__tests__/checks/**` trigger the App vitest job. Editing `ci.yml` sets `ci==true` → all 3 audit jobs run. `static-checks` runs `pre-pr.sh` unconditionally → the new `.mjs` guards fire. No parity gap.
- `dorny/paths-filter` `ci:` output must include `.github/dependabot.yml` and `.github/workflows/dependency-signatures.yml`? Not required — those don't gate a test job; they are the artifacts themselves. Confirm no guard greps them expecting a filter entry.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `cli/package.json` explicit `publishConfig.provenance: true` + fail-closed post-publish attestation assertion (INV-C1b) | locked |
| C2 | `npm audit signatures` verifier in 3 audit jobs + weekly cron sweep; un-masked exit; can-fail demonstrated (INV-C2c) | locked |
| C3 | Dependabot npm ecosystems (root/cli/extension), no auto-merge (wired `pre-pr.sh` guard), no swift | locked |
| C4 | crypto/auth 3-workspace sensitive-dep manifest + three-set reconciliation guard (A/B/C/D), per-function RT7 self-tests, CODEOWNERS-gated manifest+test, `≥10`-char reason + owners-enum | locked |

Round 2 closed with no Critical and no open Major (both Round-2 Majors — SEC-5 member-set, SEC-6 control-gate — were reflected into the contracts above). All contracts re-locked after the Round-2 revisions.
