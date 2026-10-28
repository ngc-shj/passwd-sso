import Foundation
import Shared

/// The app shell's work on returning to the foreground, separated from SwiftUI
/// so its ordering against the passkey-requirement gate is testable (mirrors
/// `BackgroundSyncRunner.attempt`).
///
/// 1. Drain the AutoFill extension's rollback tamper reports. Always attempted:
///    the server exempts the report from the passkey gate, so a passkey-less
///    member can still report tampering while the access token is live. Once it
///    has expired, the refresh is gated and the report stays queued.
/// 2. While a `PASSKEY_REQUIRED` refusal is recorded, stop — the token re-mint
///    and the sync would be refused the same way. Wait for the user.
/// 3. Re-mint the short-lived AutoFill upload token (plan C6) so a passkey
///    registration started soon after foregrounding finds a live token.
/// 4. Re-sync the encrypted-entries cache. Errors keep the cached data: a dead
///    session or a passkey refusal is recorded/handled elsewhere, anything
///    else is transient.
enum ForegroundRefresh {
  /// Runs on the caller's actor (`#isolation`), so the app shell's main-actor
  /// closures are never sent across an isolation boundary.
  static func run(
    passkeyRequirement: PasskeyRequirementStore,
    drain: () async -> Void,
    remint: () async -> Void,
    sync: () async throws -> Void,
    isolation: isolated (any Actor)? = #isolation
  ) async {
    await drain()
    guard automaticServerCallsAllowed(store: passkeyRequirement) else { return }
    await remint()
    try? await sync()
  }
}
