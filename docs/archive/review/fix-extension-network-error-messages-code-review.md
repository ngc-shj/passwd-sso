# Code Review: fix-extension-network-error-messages
Date: 2026-03-11T04:10:00+09:00
Review round: 2 (all findings resolved)

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

## Round 2 Findings (CORS extension support)

### [F3] Major — Firefox/Safari UUID regex too permissive
- **Problem**: `moz-extension` regex used `[0-9a-fA-F-]{36}` allowing all-hyphens
- **Impact**: Could accept malformed extension origins
- **Action**: Changed to strict UUID segment validation `[0-9a-f]{8}-[0-9a-f]{4}-...`
- **Status**: Resolved

### [T5] Major — No tests for extension origin CORS paths
- **Problem**: `isExtensionOrigin()` and `allowExtension` option had zero test coverage
- **Action**: Added 7 tests in `cors.test.ts` covering valid/invalid/malformed extension origins
- **Status**: Resolved

## Round 2 Expert Review Results

All three expert agents (functionality, security, testing) confirmed Round 1 fixes are correct.
- Functionality: No findings
- Security: No findings
- Testing: Minor × 3 (test coverage improvements)

### [T6] Minor — No malformed safari-web-extension rejection test
- **Action**: Added test for malformed Safari extension origin
- **Status**: Resolved

### [T7] Minor — No applyCorsHeaders rejection test without allowExtension
- **Action**: Added test for applyCorsHeaders without allowExtension
- **Status**: Resolved

### [T8] Minor — Extension response missing Max-Age/Methods assertions
- **Action**: Added Max-Age and Allow-Methods assertions to chrome-extension test
- **Status**: Resolved

## Resolution Status

All findings resolved in round 2. Tests: 4042 passed (21 CORS tests). Build: success.
