# Code Review: centralize-version-management
Date: 2026-03-22
Review round: 2

## Round 1 Findings

### Functionality
- F-1 [Major] bump-version.sh "creates a git tag" comment — RESOLVED
- F-2 [Major] release.yml direct push to main — RESOLVED (PR-based)
- F-3 [Minor] suggest_bump BREAKING CHANGE footer — RESOLVED (%B format)
- F-4 [Minor] version-check needs comment — SKIPPED (intentional design)

### Security
- S-1 [Minor] tag_name expression injection — RESOLVED (env var)
- S-2 [Major] main direct push — RESOLVED (PR-based)
- S-3 [Minor] mutable action tag — RESOLVED (SHA pin for release-please-action)
- S-4 [Minor] current_version() path interpolation — RESOLVED (process.argv)

### Testing
- T-1 [Major] version.test.ts throw instead of skip — RESOLVED (it.skipIf)
- T-2 [Major] version-check unconditional — SKIPPED (intentional design)
- T-3 [Major] lock file sync bypasses CI — RESOLVED (PR-based)
- T-4 [Minor] format assertion — SKIPPED
- T-5 [Minor] manifest verify timeout — SKIPPED

## Round 2 Findings (all Minor)

- F-1R2 [Minor] %B body text may match feat: — SKIPPED (release-please is primary; script is fallback)
- F-2R2 [Minor] git add hardcoded lock file paths — RESOLVED (git add --update)
- F-3R2/S-2R2 [Minor] checkout/setup-node SHA pin — SKIPPED (GitHub official, existing ci.yml convention)
- T-1R2 [Minor] skipIf silent in CI — SKIPPED (cli-ci guarantees build→test order)

## Resolution Status

### F-1 [Major] Misleading header comment
- Action: Removed "and creates a git tag" from bump-version.sh L8
- Modified file: scripts/bump-version.sh:8

### F-2 [Major] Direct push to main
- Action: Rewrote release.yml to create lock file sync PR instead
- Modified file: .github/workflows/release.yml

### S-1 [Minor] Expression injection
- Action: Pass tag_name via env instead of inline expression
- Modified file: .github/workflows/release.yml

### S-2 [Major] Direct push to main
- Action: Same as F-2
- Modified file: .github/workflows/release.yml

### S-3 [Minor] Mutable action tag
- Action: SHA-pinned googleapis/release-please-action@16a9c908 (v4.4.0)
- Modified file: .github/workflows/release.yml:22

### S-4 [Minor] current_version path interpolation
- Action: Changed to process.argv pattern
- Modified file: scripts/bump-version.sh:23-25

### T-1 [Major] Throw instead of skip
- Action: Replaced with it.skipIf(!distExists)
- Modified file: cli/src/__tests__/integration/version.test.ts:15

### T-3 [Major] Lock file sync bypasses CI
- Action: Same as F-2 — PR-based flow
- Modified file: .github/workflows/release.yml

### F-2R2 [Minor] Hardcoded git add paths
- Action: Changed to `git add --update '*/package-lock.json' package-lock.json`
- Modified file: .github/workflows/release.yml:62
