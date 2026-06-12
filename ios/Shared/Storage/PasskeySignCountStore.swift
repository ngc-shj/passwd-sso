import Foundation

/// Per-credential WebAuthn signature counter, persisted in the App Group so that
/// consecutive offline assertions on this device keep strictly increasing — the
/// relying party enforces counter monotonicity (e.g. webauthn.io: "sign count of
/// N was not greater than current count of N").
///
/// The emitted count is `max(localStored, floor) + 1`, where `floor` is the last
/// server-synced count from the entry blob (`passkeySignCount`). Taking the max
/// respects a web-side use that raised the server's counter and then synced into
/// the blob, while the local store covers iOS-only uses between syncs.
public struct PasskeySignCountStore {
  private let defaults: UserDefaults

  public init(defaults: UserDefaults? = nil) {
    self.defaults = defaults
      ?? UserDefaults(suiteName: AppGroupContainer.identifier)
      ?? .standard
  }

  /// Compute, persist, and return the next monotonic sign count to emit for the
  /// given credential (base64url credentialId).
  public func next(credentialId: String, floor: UInt32) -> UInt32 {
    let key = Self.key(for: credentialId)
    let local = UInt32(clamping: defaults.integer(forKey: key))
    let next = max(local, floor) &+ 1
    defaults.set(Int(next), forKey: key)
    return next
  }

  private static func key(for credentialId: String) -> String {
    "passkeySignCount.\(credentialId)"
  }
}
