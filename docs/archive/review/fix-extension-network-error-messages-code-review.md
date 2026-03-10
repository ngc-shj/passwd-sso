# Code Review: fix-extension-network-error-messages
Date: 2026-03-11T02:55:00+09:00
Review round: 1 (all findings resolved)

## Changes from Previous Round
Initial review

## Functionality Findings

### [F1] Minor — String matching fragility
- **Problem**: Exact string matching for browser error messages may miss future variations
- **Impact**: Low — covers major 3 browsers currently
- **Action**: Changed to case-insensitive regex pattern matching
- **Status**: Resolved — used `/failed to fetch|networkerror|load failed/i`

### [F2] Minor — Non-Error thrown values silently ignored
- **Problem**: `throw "string"` would not preserve the message
- **Impact**: Very low — codebase uses `new Error()` consistently
- **Action**: Accepted risk — fallback parameter handles this case

## Security Findings

### [S1] Minor — Unmapped error messages shown raw to UI (existing issue)
- **Problem**: `humanizeError()` falls through to raw code for unknown mappings
- **Impact**: Low — browser fetch errors are now normalized; server errors already use coded responses
- **Action**: Out of scope — pre-existing behavior, not worsened by this change

## Testing Findings

### [T1] Major — `login-save.ts` catch blocks not using `normalizeErrorCode`
- **Problem**: Two catch blocks in `login-save.ts` still used raw `err.message`
- **Action**: Applied `normalizeErrorCode` to both catch blocks
- **Status**: Resolved

### [T2] Major — Existing test used unrealistic error message "NetworkError"
- **Problem**: Test at `background.test.ts:1276` used `"NetworkError"` which no browser produces
- **Action**: Changed to `"Failed to fetch"` (Chrome's actual message)
- **Status**: Resolved

### [T3] Minor — No unit tests for `normalizeErrorCode`
- **Action**: Created `extension/src/__tests__/lib/error-utils.test.ts` with 6 test cases
- **Status**: Resolved

### [T4] Minor — No test for `NETWORK_ERROR` in `humanizeError`
- **Action**: Added assertion in `error-messages.test.ts`
- **Status**: Resolved

## Resolution Status

All findings resolved in round 1. Tests: 442 passed. Build: success.
