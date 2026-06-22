# Code Review: ios-build-number-autotrack

Date: 2026-06-22
Review round: 1 (terminal — no Round 2 needed)

## Changes from Previous Round

Initial review. Change sets `CURRENT_PROJECT_VERSION` (CFBundleVersion / build
number) to `$(MARKETING_VERSION)` across all 5 targets so release-please's
marketing-version bump advances the build number automatically — no manual bump
before App Store upload. Touches `ios/project.yml`, regenerated
`ios/PasswdSSO.xcodeproj/project.pbxproj`, and `docs/ios-app-store-listing.md`.

Reviewed by three expert sub-agents (functionality / security / testing) in
parallel. Ollama unavailable from this environment, so no local-LLM
pre-screening / seed generation; sub-agents performed full-diff review.

## Functionality Findings

**F1 — Minor: manual re-upload build-number lifecycle undocumented**
- File: `docs/ios-app-store-listing.md:206-209`
- Evidence: Step 2 manual-case example sets `CURRENT_PROJECT_VERSION` to a literal
  `0.4.59.1` but did not warn it must be reverted to `$(MARKETING_VERSION)`.
- Problem: leaving the literal freezes the build number; the next release would
  be rejected for a duplicate build number.
- Impact: Low — only the rare same-version re-upload path; a stale override
  surfaces as a visible, recoverable duplicate-build-number rejection.
- Fix: added a "Revert it to `$(MARKETING_VERSION)` afterwards" note. **RESOLVED.**

Per-checkpoint verification (all PASS): 5-target consistency, pbxproj regen with
no drift (10 occurrences Debug+Release), linear `CFBundleVersion →
CURRENT_PROJECT_VERSION → MARKETING_VERSION → 0.4.59` resolution (no cycle),
format valid for the automated `X.Y.Z` stream (release-please-config.json has no
prerelease setting), release-please generic updater touches only
`# x-release-please-version` lines (MARKETING_VERSION), `bump-version.sh` regex
cannot touch the `$(MARKETING_VERSION)` reference line.

## Security Findings

**S1 — Low/Info: App-Review Google account email in tracked doc**
- File: `docs/ios-app-store-listing.md:123`
- Evidence: `Test Google account (email): appreview.passwdsso@gmail.com`
- Problem: login email committed in plaintext (password correctly externalized).
- Impact: Minimal — disposable account, 2FA off, no password in git; email alone
  grants no access.
- escalate: false

**S2 — Info: Apple Team ID in doc (no new exposure)**
- File: `docs/ios-app-store-listing.md:174,178`
- Evidence: `Team ID 4789NDA9RQ` — non-secret, already committed in
  `ios/project.yml:20` and pbxproj (8 occurrences). No action.

Verified PASS: committed doc carries only credential placeholders pointing to
`docs/.review-credentials.local.md`; that file is gitignored
(`git check-ignore` → `.gitignore:19`; `git status --ignored` → `!!`) and not
pulled into tracking by this change. `ITSAppUsesNonExemptEncryption: false`
carries no security risk and is accurate for standard AES-256-GCM/PBKDF2/HKDF.

## Testing Findings

No findings (Major/Minor). QA executed real verification:
- xcodegen regenerate → byte-identical to committed pbxproj (0 drift).
- Real simulator build → `plutil` on built `PasswdSSOApp.app/Info.plist` AND
  `PlugIns/PasswdSSOAutofillExtension.appex/Info.plist` both show
  `CFBundleVersion = 0.4.59` (setting proven effective in the real bundle).
- `xcodebuild test` rc=0, 565 tests, 0 failures (log "failed" strings are
  intentional negative-path test logging, not failures).
- T1/T2/T3 informational only (format adequacy, test-bundle version inert,
  config-only → no unit test required).

## Adjacent Findings

None.

## Quality Warnings

None — all findings carry file:line evidence.

## Resolution Status

### F1 Minor — manual re-upload build-number lifecycle
- Action: Added note in Step 2 that the manual `CURRENT_PROJECT_VERSION` literal
  must be reverted to `$(MARKETING_VERSION)` after the re-upload.
- Modified file: `docs/ios-app-store-listing.md:206-211`

### S1 Low — App-Review Google account email in tracked doc — Accepted
- **Anti-Deferral check**: acceptable risk (quantified).
- **Justification**:
  - Worst case: the disposable App-Review email is known to a reader of the repo,
    marginally aiding targeted phishing against that one account.
  - Likelihood: low — the account is throwaway, dedicated to App Review, holds no
    real data; its password/passphrase are gitignored, so the email alone grants
    nothing.
  - Cost to fix: low (move one line to the gitignored file) but doing so removes
    the email from the self-contained runbook, which the operator needs anyway to
    paste into App Store Connect. User chose to keep it for runbook completeness.
- **Orchestrator sign-off**: acceptable-risk exception satisfied with all three
  values stated; user explicitly chose "keep as-is".

### S2 Info / T1 / T2 / T3 — informational, no action required.

## Environment Verification Report

N/A — no environment constraints declared in Phase 1 (Phase 3 standalone review,
no plan phase). Real build + test verification was nonetheless performed by the
testing expert (see Testing Findings).
