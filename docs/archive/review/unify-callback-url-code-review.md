# Code Review: unify-callback-url
Date: 2026-03-15
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] Origin empty string behavior not documented
- **Status:** Resolved — added comment in resolveCallbackUrl JSDoc

### F2 [Minor] Backslash encoded variant
- **Status:** Resolved — URL normalization via `new URL(raw, placeholder)` handles variants

### F3 [Minor] SSR window guard
- **Status:** Rejected — "use client" directive prevents server execution

## Security Findings

### S1 [Major] Path normalization bypass (/.//evil.com)
- **Status:** Resolved — relative paths now normalized through `new URL(raw, placeholder)` constructor, verifying origin stays same after normalization

### S2 [Minor] Environment variable unset logging
- **Status:** Deferred — operational improvement, out of scope

### S3 [Minor] Fragment stripping
- **Status:** Resolved — `pathname + search` from URL constructor excludes fragment; test added

## Testing Findings

### T1 [Minor] Misleading test name "malformed URL"
- **Status:** Resolved — renamed to "rejects bare word without leading slash"

### T3 [Major] Missing javascript: URI test
- **Status:** Resolved — added test + implementation rejection for non-HTTP schemes

### T4 [Minor] Missing fragment test
- **Status:** Resolved — added "strips fragment from relative path" test

### T5 [Major] Mock inconsistency in hook test
- **Status:** Rejected — hook does not use getAppOrigin; uses window.location.origin directly

### T8 [Major] searchParams Promise shape
- **Status:** Rejected — makeSearchParams already uses Promise.resolve()

## Resolution Status
All Critical/Major findings resolved or rejected with justification.
No second review round needed.
