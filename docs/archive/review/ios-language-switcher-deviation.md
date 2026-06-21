# Coding Deviation Log: ios-language-switcher

## D1 — `.system`-removes-key test asserts baseline-revert, not `XCTAssertNil` (C2 / T3)
- **Plan said**: C2 acceptance — "Set `.system` after `.ja` → `standard.object(forKey: "AppleLanguages") == nil`."
- **Actual**: the test asserts the value reverts to the suite's pre-write baseline and is NO LONGER `["ja"]`, rather than asserting `nil`.
- **Why**: discovered during `xcodebuild test` — a suite-backed `UserDefaults` falls through to `NSGlobalDomain` for keys it does not itself hold. After `removeObject(forKey: "AppleLanguages")`, the injected suite reports the device's global `AppleLanguages` (e.g. `["ja-JP", "en-JP"]`), NOT `nil`. The production code is correct (the override IS removed from the suite); only the assertion needed to account for the fall-through. The test still provable-reds: a no-op `.system` setter leaves `["ja"]`, which the `XCTAssertNotEqual(..., ["ja"])` + baseline-equality pair catches.
- **Contract impact**: none on production behavior; C2's runtime invariant (`.system` removes the override) is unchanged and verified. The acceptance wording was over-specific about `nil`.
