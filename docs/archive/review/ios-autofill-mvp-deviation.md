# Coding Deviation Log: ios-autofill-mvp

## Step 4 (workspace scaffold) — 2026-05-02

**Deviations from plan**:

1. **`platform=iOS Simulator,id=<UDID>` instead of pinned `OS=17.2,name=iPhone 15`** in the local build/test invocation. The plan's Step 4 verification command targeted `OS=17.2,name=iPhone 15`, but Xcode 26.2 on this machine fails name-based destination resolution with `error: iOS 26.2 is not installed. Please download and install the platform from Xcode > Settings > Components.` The error is misleading — the iOS 26.2 simulator runtime is not available (only 26.0 / 26.1 / 18.x / 17.2 are installed), and Xcode's destination catalog appears confused by an unavailable physical iPhone whose build-info field is empty (`DVTDeviceOperation: Encountered a build number "" that is incompatible with DVTBuildVersion`). The reliable workaround is explicit UDID against a booted simulator: `xcrun simctl create … && xcrun simctl boot <UDID> && xcodebuild -destination "platform=iOS Simulator,id=<UDID>" …`. Documented in `ios/README.md` "Build / test". CI (Step 12) will follow the same pattern. **Why**: build environment constraint, not a design change. iOS 17.0 deployment target is unchanged; runtime selection is independent of the deployment target.

2. **`SWIFT_STRICT_CONCURRENCY: complete`** added at the project level. Not in the plan. Justification: Swift 6 default; rejecting it now would require per-target opt-out later. The cost surfaced immediately — `PasswdSSOUITests.swift` needed `@MainActor` on the test class because `XCUIApplication` is main-actor-isolated. Fixed inline, no scope change.

3. **`com.apple.developer.associated-domains: applinks:passwd-sso.invalid`** placeholder in the App entitlement. The plan describes Universal Links pointing at the user's `passwd-sso` server domain (configured per-deployment), but Xcode requires the entitlement key to be present and well-formed at build time. Using `passwd-sso.invalid` (per RFC 2606) makes the simulator build pass while signaling the value is a placeholder. Step 6 (auth flow) will document the per-deployment customization in `ios/README.md`.

**Tooling additions** (not strictly deviations from the design but worth recording):

- **XcodeGen 2.45.4** (Homebrew) introduced as the project-generation tool. The `.xcodeproj` is committed (not just `project.yml`) so opening in Xcode does not require XcodeGen pre-installed; XcodeGen is only needed when changing `project.yml`. CI's `ios-ci` job (Step 12) will install XcodeGen via Homebrew and regenerate to verify `project.yml` matches the committed `.xcodeproj`.
