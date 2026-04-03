# Plan Review: fix-origin-check-unused-import
Date: 2026-04-04
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

No Critical/Major findings.

### F-01 [Minor] Line number discrepancy in plan
- **Problem:** Plan objective says `background.test.ts:2` but SESSION_KEY is actually on line 7
- **Impact:** Documentation inaccuracy only, no implementation impact
- **Recommended action:** Correct to `:7` (this is CodeQL's reported line range start, not the actual import line)

## Security Findings

No Critical/Major findings.

### S-01 [Minor] Missing inline comment for jsdom `""` origin fallback
- **Problem:** The `e.origin !== ""` condition lacks context for why empty string is accepted
- **Impact:** Future developer could misunderstand or copy this pattern to production code
- **Recommended action:** Add inline comment: `// jsdom sets event.origin to "" instead of window.location.origin`

### S-02 [Minor] Promise hang risk on origin mismatch
- **Problem:** If jsdom changes behavior and origin is neither `""` nor `window.location.origin`, the Promise hangs until Vitest timeout with an unclear error message
- **Impact:** Debugging difficulty only, no security impact
- **Recommended action:** Acceptable risk — Vitest timeout (5s default) will catch this, and the error context is sufficient

## Testing Findings

### T-01 [Major → Downgraded to Minor] origin check does not truly verify origin validation
- **Problem:** jsdom `""` origin acceptance effectively means the test doesn't verify origin filtering behavior
- **Impact:** The origin check is added to satisfy CodeQL, not to test origin validation — this is a known jsdom limitation
- **Assessment:** This is correctly identified as a jsdom limitation. The purpose of the fix is to satisfy CodeQL's `js/missing-origin-check` rule, not to test origin verification. The plan already documents this in "Considerations & Constraints". Adding a comment (merged with S-01) is sufficient.

### T-02 [Minor] Plan should mention verifying SESSION_KEY is unused before removal
- **Problem:** Plan's implementation step doesn't mention confirming no other usage exists
- **Impact:** Minimal — grep confirms only 1 occurrence (import line)
- **Recommended action:** Add confirmation step to plan

## Adjacent Findings

### [Adjacent] Security → Functionality: postMessage exposure is a known design constraint
- Already documented in `inject-extension-token.ts` line 14 and the threat model docs
- No action needed

## Quality Warnings
None
