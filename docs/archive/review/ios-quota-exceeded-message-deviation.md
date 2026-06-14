# Coding Deviation Log: ios-quota-exceeded-message

## Phase 2 implementation

All five contracts (C1-C5) implemented as locked. No functional deviations from the plan.

Minor, non-functional notes:
- The `MobileAPIError.quotaExceeded` doc comment was worded to describe the server's quota error code
  *without* embedding the literal `"QUOTA_EXCEEDED"` token, so the C2 forbidden-pattern grep
  (`"QUOTA_EXCEEDED"` must appear at most once in `MobileAPIClient.swift`) resolves to exactly one hit (the
  detection comparison). Documentation value preserved; not a behavior change.
- Test helper naming: the 4 quota tests live in the `MobileAPIClientTests` class, which constructs clients
  inline (its `makeClient(...)` helper belongs to a different test class in the same file). Added a local
  `makeCreateClient()` helper mirroring the existing inline construction pattern — not a deviation, just
  matching the class's established style.

Verification:
- `xcodegen generate` → `build-for-testing` (TEST BUILD SUCCEEDED) → `test-without-building`:
  468 unit tests + 2 UI tests, 0 failures, no crashes (iPhone 15 Pro simulator).
- Contract conformance grep: `status == 403` quota-branch absent; `"QUOTA_EXCEEDED"` appears once; no jargon in
  catalog strings; old `"Save failed: %@"` key fully removed (no residual references).
