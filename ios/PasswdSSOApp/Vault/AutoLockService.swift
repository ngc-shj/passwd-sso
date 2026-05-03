import Foundation
import Shared

/// Manages auto-lock and manual lock for the host app.
/// `LockStateReducer` contains the pure logic; this class owns the live timer.
@Observable @MainActor public final class AutoLockService {
  public enum State: Sendable, Equatable {
    case unlocked
    case locked
  }

  public private(set) var state: State = .locked
  public var autoLockMinutes: Int {
    get { _autoLockMinutes }
    set { _autoLockMinutes = max(1, min(60, newValue)) }
  }

  private var _autoLockMinutes: Int = 5
  private var lastActivityAt: Date = Date()
  private var timer: Foundation.Timer?
  private let reducer: LockStateReducer
  private let clock: Clock
  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: WrappedKeyStore
  private let tokenStore: HostTokenStore
  private let cacheURL: URL

  public init(
    reducer: LockStateReducer = LockStateReducer(),
    clock: Clock = SystemClock(),
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    tokenStore: HostTokenStore,
    cacheURL: URL
  ) {
    self.reducer = reducer
    self.clock = clock
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.tokenStore = tokenStore
    self.cacheURL = cacheURL
  }

  /// Record user interaction — resets the idle timer.
  public func recordActivity() {
    lastActivityAt = clock.now
    if state == .unlocked {
      // No state change needed; the tick will check the new lastActivityAt.
    }
  }

  /// Start the 1-second tick timer. Call after unlock.
  public func startTimer() {
    stopTimer()
    lastActivityAt = clock.now
    state = .unlocked
    timer = Foundation.Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.tick()
      }
    }
  }

  /// Stop the timer without locking.
  public func stopTimer() {
    timer?.invalidate()
    timer = nil
  }

  /// Drop vault_key from memory, delete bridge_key_blob from Keychain.
  /// Keeps cache + wrapped blobs (so AutoFill shows "Open passwd-sso to refresh").
  public func lock() {
    stopTimer()
    state = .locked
    try? bridgeKeyStore.delete()
  }

  /// Full sign-out: lock + delete tokens + clear cache + clear wrapped blobs.
  public func signOut() {
    lock()
    try? tokenStore.deleteAll()
    try? wrappedKeyStore.clearAll()
    let fm = FileManager.default
    if fm.fileExists(atPath: cacheURL.path) {
      try? fm.removeItem(at: cacheURL)
    }
  }

  // MARK: - Private

  private func tick() {
    guard state == .unlocked else { return }
    let elapsed = clock.now.timeIntervalSince(lastActivityAt)
    if elapsed >= Double(_autoLockMinutes * 60) {
      lock()
    }
  }
}
