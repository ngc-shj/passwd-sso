# Plan: Security Hardening Roadmap (P1–P4)

## Project context

- Type: `mixed` — Next.js 16 web app + CLI (npm) + browser extension + iOS (Swift) + CI/CD guard suite
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest, real-DB integration, Playwright, XCTest, a large `scripts/checks/*` static-guard suite)
- Verification environment constraints:
  - VC1: iOS XCTest real-TLS fixtures require macOS + Xcode; the developer's primary environment is Linux. iOS guard/fixture behavior is `verifiable-CI` (macOS runner) but NOT verifiable-local.
  - VC2: Sigstore/cosign keyless signing requires GitHub Actions OIDC; cannot be exercised from a local dev machine → `verifiable-CI` only.
  - VC3: Container-image SBOM (syft on an image) requires a built image; `verifiable-CI`.

## Objective

Deepen four existing security postures, in the priority order the roadmap proposes
(recommended *sequencing* P3 → P4 → P2 → P1; risk *ranking* P1 > P2 > P4 > P3):

- P1 — Supply-chain monitoring (SBOM, provenance/signing, dependency policy, Actions boundary hardening)
- P2 — Worker runtime invariants (shared wrapper, idempotency key, poison/dead-letter, destructive batch caps, manifest↔code CI parity)
- P3 — Certificate fixture expiry management (iOS real-TLS test fixtures)
- P4 — CI-guard self-test maintenance (4-fixture sets, error identifiers, coverage manifest)

## Ground-truth reconciliation (verified against the repo before review)

The roadmap prose was written from memory and contains several factual errors that
change the shape of the work. Reviewers MUST review against these verified facts,
not the roadmap's original wording.

### P3 corrections (material)

- **GT-P3-a**: The committed iOS TLS fixtures are `ios/PasswdSSOTests/fixtures/TLS/tlsLeafA.p12`,
  `tlsLeafB.p12` (PKCS#12, password `passwd-sso-test`, public) and `testLocalCA.der`
  (DER). There are **no** `leaf-a.pem` / `leaf-b.pem` / `ca.pem` files. The roadmap's
  `openssl x509 -checkend leaf-a.pem` command targets nonexistent files and would
  silently need path fixes.
- **GT-P3-b**: The CA (`testLocalCA.der`) expires **2126-06-20**, not 2027. Only the
  **leaves** are short-lived: `LEAF_DAYS=397` in the generator (Apple's ~398-day TLS
  leaf cap, SecTrust -67901). The "leaf失効日 2027-08-15" figure is a stale guess; the
  real expiry is `generation date + 397 days` and must be read from the fixture, not
  hardcoded.
- **GT-P3-c**: A deterministic generator **already exists**:
  `ios/scripts/generate-tls-test-fixtures.sh`. It already does EC P-256, SAN
  `localhost,127.0.0.1`, `basicConstraints=CA:FALSE`, `extendedKeyUsage=serverAuth`,
  same test CA signing both leaves, `LEAF_DAYS=397` (≤398), fixed output filenames,
  and prints each leaf's expiry. So P3.2 ("make regeneration deterministic") is
  ~90% done; the true gaps are (i) an **expiry-check script** that can read a `.p12`,
  (ii) a **scheduled workflow**, (iii) **README documentation** of the procedure
  (currently absent — `grep` finds no TLS-fixture section in `ios/README.md`).
- **GT-P3-d**: An expiry check CANNOT run `openssl x509 -checkend` on a `.p12`
  directly. It must extract the leaf cert first:
  `openssl pkcs12 -in tlsLeafA.p12 -nokeys -passin pass:passwd-sso-test -legacy | openssl x509 -checkend N -noout`.
  The CA is DER: `openssl x509 -inform der -in testLocalCA.der -checkend N -noout`
  (and the CA effectively never expires, so a CA check is near-useless — the check
  should target the leaves).

### P4 corrections (premise is aspirational, not current-state)

- **GT-P4-a**: `scripts/checks/tests/` does **not** exist. The roadmap's claim that
  guards "currently hold 4 fixture kinds" is a target, not a description. Today only
  **one** guard has a regression test: `scripts/__tests__/check-count-then-create-lock.test.mjs`,
  which uses an **env-var-root** pattern (`CTC_CHECK_ROOT=<tmpdir>`) and writes fixture
  source into a fresh `mkdtempSync` tree — NOT a committed `positive/negative/stale/false-positive`
  directory layout. This is the established, working isolation idiom in this repo.
- **GT-P4-b**: The iOS pinning guard (`check-ios-authenticated-session-pinning.sh`)
  has **no** self-test and emits no machine-readable identifiers — it prints prose and
  `exit 1`. It DOES already have a second "stale allowlist entry" guard clause inside it.
  It reads its scan root from `$IOS_DIR` derived from `BASH_SOURCE`, i.e. it is **not**
  currently parameterized for an isolated fixture root the way the count-then-create
  guard is (`CTC_CHECK_ROOT`). Adding a self-test requires first making the guard's
  scan root overridable — a prerequisite the roadmap does not mention.

### P2 corrections (deepening, not greenfield)

- **GT-P2-a**: `scripts/checks/worker-policy-manifest.json` + its parity test
  (`src/__tests__/workers/worker-policy-manifest.test.ts`) already exist and already
  mechanically verify `rawSql` / `destructive` / `emitsAudit` / `usesSecurityDefiner`
  per worker by grepping declared modules. The manifest already records `idempotent`,
  `retryPolicy`, `poisonMessageHandling` as **prose (presence-only)** doc fields. So
  P2.5 ("manifest↔code parity") partly exists; the delta is upgrading the prose doc
  fields to mechanically-verified (`destructive:true ⇒ DELETE present`,
  `maxAttempts:N ⇒ code constant = N`, `batchSize:N ⇒ LIMIT ≤ N`).
- **GT-P2-b**: Workers today already implement retry/backoff, dead-letter (FAILED
  status + `AUDIT_OUTBOX_DEAD_LETTER`), and `ON CONFLICT DO NOTHING` idempotency
  **per-worker, ad hoc**. P2's shared `runWorkerJob` wrapper + `WorkerExecution`
  idempotency table is a **consolidation/refactor** of working behavior, carrying
  regression risk to a security-audit-critical path (audit outbox). It is NOT adding
  a missing capability.

### P1 corrections

- **GT-P1-a**: GitHub Actions are already SHA-pinned, with a guard
  (`check-actions-sha-pinned.sh`) and Dependabot for the `github-actions` ecosystem.
- **GT-P1-b**: Dependabot currently covers **only** `github-actions`. The npm/Swift/
  container ecosystems are NOT yet configured (the file comment says "can be added
  later"). So P1.3's "dependency policy" is partly new config, not just tightening.
- **GT-P1-c**: `release.yml` publishes the CLI to npm via **OIDC Trusted Publishing**
  (no long-lived token) and already scopes `id-token: write` to the publish job only.
  No SBOM / cosign / provenance-attestation exists yet.
- **GT-P1-d**: There is no container image build/publish in the current release
  workflow (release-please + CLI npm publish only). Container-image SBOM/signing (P1.1
  image row, P1.2 image signing) has **no producer to attach to yet** — the roadmap
  assumes a container release path that isn't in `release.yml`.

## Contracts (per initiative — high-level roadmap granularity; contract-first locking deferred to per-PR plans)

This is a **roadmap review**, not a single-PR implementation plan. Each Pn below is a
future PR (or PR series) that will get its own contract-locked plan. The purpose of
THIS review is to validate scope, sequencing, feasibility, and correctness of the
approach — and to catch the ground-truth errors above before any PR starts.

- **C-P3** (next small PR): TLS-fixture expiry check + monthly workflow + README doc.
  Signatures: `scripts/checks/check-tls-fixture-expiry.sh` (reads leaves via `openssl
  pkcs12 | openssl x509 -checkend`); a `.github/workflows/*.yml` monthly cron; a
  README section documenting `generate-tls-test-fixtures.sh`.
- **C-P4** (next small PR, bundled with C-P3): iOS pinning-guard self-test with
  positive/negative/stale/false-positive cases; guard error identifiers; a guard
  coverage manifest checked in CI. Prerequisite: parameterize the guard's scan root.
- **C-P2** (medium PR series): shared `runWorkerJob` wrapper, `WorkerExecution`
  idempotency table + claim, retry-cap/dead-letter states, destructive batch caps,
  manifest↔code mechanical parity — starting with `audit-outbox-worker` only.
- **C-P1** (ongoing release-ops): SBOM per release, provenance/signing (cosign +
  `attest-build-provenance`), dependency policy (Dependabot npm/Swift/container +
  advisory gating), Actions boundary (CODEOWNERS on workflows, ban `pull_request_target`,
  default `read-all` permissions, third-party action allowlist).

## Testing strategy

- P3/P4: the expiry check and guard self-tests are themselves testable in CI; the
  iOS guard self-test must be proven able to FAIL (RT7) — a negative fixture that a
  broken guard would pass.
- P2: per-worker integration tests for idempotency (double-run → one side effect),
  dead-letter transition, destructive batch cap; AST/grep manifest parity in CI.
- P1: signature *verification* must run in CI and at deploy; deploy by digest not tag.

## Considerations & constraints

- **Scope contract**:
  - SC1: Container-image SBOM/signing (P1.1/P1.2 image rows) is **deferred** until a
    container release path exists in `release.yml` (GT-P1-d) — no producer today.
    Owner: a future "containerize release" PR.
  - SC2: iOS distribution-artifact provenance (P1.2 iOS row) is deferred — iOS ships
    via App Store Connect, not a GitHub-Actions-built artifact cosign can sign.
  - SC3: P2 shared-wrapper rollout to workers beyond `audit-outbox-worker` is deferred
    to later PRs in the series; the first PR proves the pattern on one worker.
  - SC4: Worker doc-field prose *accuracy* (tenantScoped reason, etc.) remains a human-
    review concern per the existing manifest's SC3 note; mechanization covers only the
    grep-derivable fields.
- **Risk vs. sequencing divergence is intentional**: P3/P4 are low-risk, low-cost,
  and time-sensitive (P3 fixtures lapse ~yearly), so they go first despite P1/P2 being
  higher-risk. Reviewers should validate this trade-off, not just the risk ranking.

## Go/No-Go Gate

This is a roadmap-level review. Per-contract locking happens in each Pn's own plan.

| ID   | Subject                                             | Status  |
|------|-----------------------------------------------------|---------|
| C-P3 | TLS fixture expiry check + workflow + README doc    | pending |
| C-P4 | iOS pinning guard self-test + identifiers + manifest| pending |
| C-P2 | Worker runtime invariants (audit-outbox first)      | pending |
| C-P1 | Supply-chain: SBOM/provenance/dep-policy/Actions    | pending |
