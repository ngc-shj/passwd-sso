# Plan: CI-Guard & TLS-Fixture Hardening (C-P3 + C-P4)

Branch: `feature/ci-guard-fixture-hardening`

Bundles the two low-risk, time-sensitive roadmap items (P3 cert-fixture expiry,
P4 iOS-guard self-test) into one PR. Contract-locked, with every Critical/Major
finding from `security-hardening-roadmap-review.md` folded in.

## Project context

- Type: `mixed` (this PR touches only `scripts/checks/`, `scripts/__tests__/`,
  `.github/workflows/`, `ios/README.md` — no product runtime code).
- Test infrastructure: `unit + integration + E2E + CI/CD`. New self-tests are
  `*.test.mjs` under `scripts/__tests__/**`, auto-discovered by vitest
  (`vitest.config` include line 11) — same job as every other guard self-test.
- Verification environment constraints:
  - VC1: XCTest real-TLS *consumption* (ServerTrustRealTLSTests) is macOS-CI-only.
    But the two NEW self-tests here are **bash + openssl + grep**, Linux-runnable
    in the `static-checks` (ubuntu-latest) job and locally → `verifiable-local`.
    Only the XCTest that *uses* the fixtures stays `blocked-deferred`-to-macOS-CI;
    it is out of scope for this PR (SC1).
  - VC2 (n/a here — no signing).

## Objective

1. **C-P3**: catch iOS TLS test-fixture leaves *before* they lapse (leaves are
   397-day, Apple's ~398-day cap), via a Linux-runnable expiry-check guard, a
   monthly cron, and README documentation of the existing generator.
2. **C-P4**: give the iOS pinning guard a real self-test proving it can FAIL for
   each of its three fail branches, using stable machine-readable identifiers and
   env-root isolation — without touching the working tree.

## Technical approach

- The expiry check lives in `static-checks` (ubuntu-latest, OpenSSL 3.x) — NOT the
  macOS iOS job — because the committed `.p12` is `-legacy`-encrypted and
  macos-latest ships LibreSSL, which rejects `-legacy` (review M-a / R16). Verified
  locally: `openssl version` = OpenSSL 3.6.3; `-clcerts -legacy` reads the leaf.
- Leaf selection uses `openssl pkcs12 -clcerts` so ONLY the leaf cert (CN=localhost)
  reaches `openssl x509`, never the 2126-expiry CA (review X3). Verified:
  `-nokeys -clcerts` emits exactly the `CN=localhost` leaf.
- Passphrase passed via `-passin env:` never `pass:<literal>` on argv (review m-3 /
  RS6) — models the correct idiom even though this passphrase is intentionally public.
- The iOS guard gains a single `IOS_PINNING_CHECK_ROOT` override at the `IOS_DIR`
  assignment (line 34). Because grep roots (78), `rel`-strip (66), and allowlist
  resolution (86) all derive from `$IOS_DIR`, one override threads through all three
  (review X1). CI/pre-pr invoke it with no override → real `ios/`.

## Contracts

### C1 — `scripts/checks/check-tls-fixture-expiry.sh` (new)

- **Signature**: bash script, no args. Reads `$TLS_FIXTURE_CHECK_ROOT` (default
  `<repo>/ios/PasswdSSOTests/fixtures/TLS`) and `$TLS_FIXTURE_CHECKEND_DAYS`
  (default `30`). Exit 0 = all leaves valid past the window; exit 1 = at least one
  leaf expired/expiring, or an extraction failure.
- **Behavior**: for each `tlsLeaf*.p12` in the root:
  `openssl pkcs12 -in "$p12" -nokeys -clcerts -passin env:TLS_FIXTURE_PASS -legacy`
  piped to `openssl x509 -checkend $((DAYS*86400)) -noout`. `TLS_FIXTURE_PASS`
  defaults to the public `passwd-sso-test` inside the script.
- **Three distinct outcomes, not collapsed** (review M-b): the script must classify
  and print a stable identifier per outcome:
  - leaf valid past window → print `TLS_FIXTURE_OK: <name> valid until <enddate>`, continue.
  - leaf expired/within window → print `TLS_FIXTURE_EXPIRING: <name> ...`, set fail.
  - extraction failed (pkcs12 stage non-zero: wrong pass, missing `-legacy`, DER/PEM
    mixup, empty stream) → print `TLS_FIXTURE_UNREADABLE: <name> ...`, set fail.
    Extraction failure MUST be detected explicitly (capture the leaf PEM to a
    variable/temp and check it is non-empty) — NOT swallowed by pipefail.
- **Invariants** (app-enforced):
  - INV-C1a: script runs under `set -euo pipefail`; the two-stage extraction cannot
    false-pass on a stage-1 failure (review M-a / R44).
  - INV-C1b: `-clcerts` present on every `openssl pkcs12` invocation → the CA is
    never the checked cert (review X3). **Forbidden pattern**: an `openssl pkcs12`
    line reaching an `openssl x509 -checkend` without `-clcerts`.
  - INV-C1c: passphrase via `-passin env:`; **forbidden pattern**:
    `-passin pass:` literal anywhere (review m-3).
- **Forbidden patterns**:
  - `pattern: -passin pass: — reason: passphrase on argv leaks to process list (RS6)`
  - `pattern: pkcs12 [^|]*\| *openssl x509 (no -clcerts between) — reason: unpinned leaf selection (X3)` (enforced by review + C4 self-test, not grep — regex is approximate)
- **Acceptance criteria**:
  - Against the real committed fixtures with default 30-day window → exit 0 today
    (leaf expires 2027-08-15, far outside 30 days). Verified pre-plan: `-checkend 0` = valid.
  - Against a deterministically-expired fixture → exit 1 with `TLS_FIXTURE_EXPIRING`.
  - Against an unreadable/wrong-pass fixture → exit 1 with `TLS_FIXTURE_UNREADABLE`.

### C2 — `.github/workflows/tls-fixture-expiry.yml` (new)

- **Signature**: workflow, `on: schedule: cron "0 3 1 * *"` (monthly) +
  `workflow_dispatch`. `runs-on: ubuntu-latest`. `permissions: contents: read`.
- **Behavior**: runs C1 with a **look-ahead** window (`TLS_FIXTURE_CHECKEND_DAYS=45`)
  so it warns ~1.5 months before lapse (review m-2: cron uses a longer horizon than
  the PR-CI check). On failure it does NOT auto-regenerate — it fails the job (an
  actionable red) and the run log names the fixture + `generate-tls-test-fixtures.sh`.
- **Invariants**:
  - INV-C2a: `permissions:` defaults to `contents: read` (no write) — review m-5 posture.
- **Acceptance criteria**: manually triggerable via `workflow_dispatch`; green today;
  would go red 45 days before the committed leaf's 2027-08-15 expiry.

### C3 — C1 wired into `static-checks` (PR-CI) + `pre-pr.sh`

- **Signature**: one `run_step "Static: tls-fixture-expiry" bash
  scripts/checks/check-tls-fixture-expiry.sh` line in `pre-pr.sh` (after the other
  iOS static guards, ~line 172), inheriting the ubuntu-latest static-checks job
  (review M-a: OpenSSL 3.x runner).
- **Behavior**: PR-CI uses a **short** window (default 30 days) — blocks a PR that
  would ship already-lapsed-or-imminent fixtures (review m-2: CI short, cron long).
- **Invariants**: INV-C3a: the guard runs in a job whose openssl is OpenSSL 3.x
  (ubuntu), never LibreSSL (macos). Documented in a comment on the run_step line.
- **Acceptance criteria**: `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` includes the
  step and it passes today.

### C4 — `scripts/__tests__/check-tls-fixture-expiry.test.mjs` (new self-test)

- **Signature**: vitest `*.test.mjs`, auto-discovered. Runs the real C1 script via
  `execFileSync` against isolated fixture roots (`TLS_FIXTURE_CHECK_ROOT=<tmpdir>`),
  never the repo fixtures — mirrors the `CTC_CHECK_ROOT`/`mkdtempSync` idiom of
  `check-count-then-create-lock.test.mjs`.
- **Cases (each maps to a distinct C1 branch — RT7)**:
  - `valid leaf → exit 0, stdout has TLS_FIXTURE_OK`: generate a fresh leaf (`-days 400`)
    into the tmp root, assert pass. (RT7 positive.)
  - `expired leaf → exit 1, stderr/stdout has TLS_FIXTURE_EXPIRING`: generate `-days -1`
    (already-expired at creation — deterministic, no clock-freezing per review M-b),
    assert the **expiring identifier** fired. (**RT7 red case — proves the guard CAN fail.**)
  - `unreadable/wrong-pass p12 → exit 1, TLS_FIXTURE_UNREADABLE`: pass wrong
    `TLS_FIXTURE_PASS`, assert the **unreadable identifier** fired (NOT a generic exit 1)
    — proves extraction failure is distinguished from expiry (review M-b, RT8).
- **Invariants**: INV-C4a: at least one case asserts `code === 1` AND a specific
  identifier string (not exit-code-only) — the red-case gate (review M-k).
- **Testability note (RT2)**: test-side leaf generation uses the same openssl in the
  vitest environment; no macOS/Xcode dependency (VC1 does not apply — Linux-runnable).

### C5 — iOS pinning guard: env-root override + error identifiers

- **Signature change to `scripts/checks/check-ios-authenticated-session-pinning.sh`**:
  - Line 34: `IOS_DIR="${IOS_PINNING_CHECK_ROOT:-$REPO_ROOT/ios}"`. Single override;
    threads through grep roots (78), `rel`-strip (66), allowlist resolution (86)
    because all derive from `$IOS_DIR` (review X1 — verified line structure).
  - **Fail-closed on override (review m2/Security)**: if `IOS_PINNING_CHECK_ROOT` is
    set, resolve it to an absolute path and require it to be an existing directory;
    exit non-zero with `PINNING_CHECK_ROOT_INVALID` if it does not exist. (Prevents a
    PR pointing the guard at a nonexistent/empty dir to pass trivially.)
  - **Stable identifiers** at the three `fail=1` sites (review M-l / RT8), printed
    alongside the existing prose:
    - line 73 (non-allowlisted construction) → `UNPINNED_URLSESSION_CONSTRUCTION`
    - line 88 (allowlist names missing file) → `ALLOWLIST_MISSING_FILE`
    - line 92 (allowlist entry no longer constructs) → `ALLOWLIST_STALE_ENTRY`
- **Invariants**:
  - INV-C5a: with no override, behavior against the real `ios/` is byte-identical to
    today (still exit 0 on the current clean tree) — pure additive change. Acceptance:
    `bash scripts/checks/check-ios-authenticated-session-pinning.sh` still passes.
  - INV-C5b: identifiers are a **test contract** — changing one is a breaking change to
    C6. Documented in a comment. Prose remains advisory (C6 asserts the identifier,
    not the full prose — avoids the brittle full-string match).
- **Forbidden patterns**: none new.
- **Acceptance criteria**: real-tree run unchanged; override run against a tmp tree
  works; invalid override fails closed.

### C6 — `scripts/__tests__/check-ios-authenticated-session-pinning.test.mjs` (new self-test)

- **Signature**: vitest `*.test.mjs`. Runs the real C5 guard via `execFileSync` with
  `IOS_PINNING_CHECK_ROOT=<tmpdir>`. Every fixture tree seeds
  `Shared/Network/ServerTrustService.swift` **containing** a `URLSession(` construction,
  so the allowlist clause stays green and does not spuriously fire (review X1 —
  the coupled second invariant).
- **Cases — derived from the guard's ACTUAL branches, NOT the 4-kind template**
  (review X2):
  - `clean tree → exit 0`: seeded `ServerTrustService.swift` (allowlisted) + a
    non-constructing production file. **Positive-passes case, asserted first** so the
    harness proves it isn't spuriously red before the negatives (review X1).
  - `non-allowlisted construction → exit 1 + UNPINNED_URLSESSION_CONSTRUCTION`: add
    `PasswdSSOApp/Foo.swift` with `URLSession.shared`. (**RT7 red case.**)
  - `allowlisted file missing → exit 1 + ALLOWLIST_MISSING_FILE`: omit
    `ServerTrustService.swift` from the tree. (Exercises the stale-clause branch A.)
  - `allowlisted file no longer constructs → exit 1 + ALLOWLIST_STALE_ENTRY`: seed
    `ServerTrustService.swift` WITHOUT any `URLSession(`. (Stale-clause branch B.)
  - `construction only in a comment/string in a production file → exit ???`
    **(known-limitation fixture)**: seed `PasswdSSOApp/Bar.swift` with `// URLSession(`
    in a comment. The current guard is pure grep with no comment-blanking, so it
    **fails this (false positive)**. This PR does NOT fix the guard; the fixture PINS
    the current behavior with a comment `// KNOWN FALSE-POSITIVE: guard has no
    comment-blanking; see roadmap review X2` so a future comment-aware upgrade has a
    regression anchor. (review X2 — the genuinely valuable case the template would hide.)
  - `invalid override root → exit 1 + PINNING_CHECK_ROOT_INVALID`: set the env to a
    nonexistent path (review m2 fail-closed).
- **Invariants**: INV-C6a: ≥1 case asserts `code === 1` with a specific identifier
  (red-case gate, review M-k). INV-C6b: assertions match the **identifier**, not the
  full prose (review M-l / INV-C5b).

### C7 — README documentation of the TLS fixture procedure (review GT-P3-c)

- **Signature**: a section in `ios/README.md` (currently absent — grep found none).
- **Content**: how to regenerate (`ios/scripts/generate-tls-test-fixtures.sh`), that
  leaves are 397-day / re-run ~yearly, that the CA is long-lived, that the expiry
  check (C1) + monthly cron (C2) warn before lapse, that the passphrase is
  intentionally public and the keys are test-only (SAN=localhost, CA:FALSE) and MUST
  NOT be used in production.
- **Acceptance**: `check-doc-paths.mjs` (if it validates README links) stays green.

## Scope contract

- **SC1**: The XCTest real-TLS *consumption* (`ServerTrustRealTLSTests`) is untouched;
  it remains macOS-CI-only (VC1). This PR only adds the expiry guard + guard self-tests.
- **SC2** (design decided during implementation — fail-closed raw-source match):
  The iOS guard matches RAW source and never strips comments/strings. An earlier
  attempt normalized comments/whitespace away before scanning; that was reverted
  because a partial lexer (no string-literal, raw-string, escape, or nested-comment
  handling) is fail-OPEN — it deletes real code it misreads as a comment, letting an
  actual construction slip through. Two concrete bypasses were demonstrated against the
  normalizer: `"https://x"; URLSession.shared` (the `//` inside the string was treated
  as a line comment, deleting the construction) and `URLSession/* /* */ */.shared`
  (non-greedy `/* */` ended at the first `*/`). The final guard instead matches raw
  source with a pattern that TOLERATES whitespace/`/* */` block-comment filler between
  the `URLSession` token and the `.`/`(` (nothing is deleted), catching the
  comment-split and whitespace-split spellings while leaving the two normalizer bypasses
  closed. Its only cost is an accepted false POSITIVE: a `URLSession` mention that lives
  purely inside a comment/string is flagged — the safe direction for a security guard.
  C6 asserts all of: comment-split, whitespace-split, string-`//`, nested-comment,
  multi-line-comment, and backtick-escaped identifier (`` `URLSession`.shared `` /
  `` URLSession.`shared` ``) — all red — plus the accepted comment-only false positive.
  The pattern uses a `(?<![A-Za-z0-9_])` boundary so URLSession used purely as a TYPE
  (`URLSessionConfiguration`, `URLSessionTask`, a `: URLSession` annotation) is NOT
  flagged — the pinned design injects the session by constructor, so ~30 real type
  references across 4 production files are legitimate and must pass; C6 pins that.
  **Accepted fail-open gap (documented, not fixed):** construction through a
  `typealias Alias = URLSession; Alias.shared` is not caught — alias resolution needs
  semantic analysis a textual guard cannot do. It requires writing an obvious alias
  (trivially caught in code review) and is pinned by an expect-PASS regression test as
  the target for a future SwiftSyntax-based upgrade. That SwiftSyntax rewrite (which
  would also close the comment-only false positive and the typealias gap in one move)
  needs a macOS-CI Swift-toolchain build step and is out of scope for this PR.
- **SC3**: A repo-wide "every guard has a self-test" presence gate (review M-k(b)) is
  deferred to the P4 continuation; this PR delivers the pattern on the two guards in scope.
- **SC4**: A count/coverage manifest is intentionally NOT built (review M-k warns it
  rewards decorative fixtures); the red-case gate (INV-C4a/INV-C6a) is the signal instead.

## Testing strategy

- Both new self-tests (C4, C6) run in the standard vitest job (Linux) and locally —
  no macOS dependency (VC1 does not reach them).
- Every guard's self-test contains ≥1 asserted-RED case with a specific identifier
  (RT7) — the guard is proven able to fail, not merely to pass.
- Mandatory checks before "complete": `npx vitest run` (C4+C6 pass) and, since only
  scripts/tests/workflows/docs change with no product runtime touched, `npx next build`
  is skipped per the project's test-only-change rule — BUT `PRE_PR_STATIC_ONLY=1 bash
  scripts/pre-pr.sh` is run to exercise C3 in the real static-checks path.

## Considerations & constraints

- **openssl `-legacy` portability**: pinned to ubuntu OpenSSL 3.x (C3/C2); never runs
  on macos LibreSSL (review M-a). If a future runner drops `-legacy`, C4's
  `TLS_FIXTURE_UNREADABLE` case catches it as a distinct failure, not a silent pass.
- **Time-dependence**: C4's expired case uses `-days -1` (expired at creation) so it is
  deterministic without clock manipulation (review M-b).
- **No product runtime change** → no security-boundary regression surface; the guards
  are additive.

## Go/No-Go Gate

| ID | Subject                                                    | Status |
|----|------------------------------------------------------------|--------|
| C1 | check-tls-fixture-expiry.sh (leaf via -clcerts, 3 outcomes)| locked |
| C2 | monthly tls-fixture-expiry.yml (look-ahead 45d, read-only) | locked |
| C3 | C1 wired into static-checks + pre-pr (ubuntu OpenSSL 3.x)   | locked |
| C4 | expiry-check self-test (RT7 red case, identifier-asserted)  | locked |
| C5 | iOS guard env-root override + 3 identifiers + fail-closed   | locked |
| C6 | iOS guard self-test (branch-derived cases, X2 known-limit)  | locked |
| C7 | ios/README.md TLS fixture procedure doc                     | locked |
