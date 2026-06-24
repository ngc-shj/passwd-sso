import Foundation
import Shared

/// Manages auto-lock and manual lock for the host app.
/// `LockStateReducer` contains the pure logic; this class owns the live timer.
@Observable @MainActor public final class AutoLockService {
  /// Why a full sign-out happened — drives where the app routes afterward.
  public enum LogoutReason: Sendable, Equatable {
    case manual       // explicit "Sign Out" — offer the URL screen (change-server path)
    case idleTimeout  // logout-on-timeout — skip the URL screen, go straight to sign-in
  }

  public enum State: Sendable, Equatable {
    case unlocked
    case locked                          // idle lock / manual Lock — tokens kept, re-unlock with passphrase
    case loggedOut(reason: LogoutReason) // tokens cleared, must sign in again
  }

  public private(set) var state: State = .locked
  public var autoLockMinutes: Int {
    get { _autoLockMinutes }
    // Ceiling is the shared max (24h), NOT 60: a tenant policy may enforce a
    // longer interval than the user picker offers, and it must not be truncated.
    set { _autoLockMinutes = max(AutoLockLimits.floorMinutes, min(AutoLockLimits.maxMinutes, newValue)) }
  }

  private var _autoLockMinutes: Int = 15

  /// What the idle timeout does at the boundary: lock (keep tokens/cache) or
  /// logout (full sign-out). Applied from AppSettingsStore at each unlock.
  /// Internal (not public) because VaultTimeoutAction is an app-level type.
  var timeoutAction: VaultTimeoutAction = .lock
  private var lastActivityAt: Date = Date()
  private var timer: Foundation.Timer?
  private let reducer: LockStateReducer
  private let clock: Clock
  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: WrappedKeyStore
  private let teamDirectoryStore: TeamDirectoryStoring
  private let tokenStore: HostTokenStore
  private let uploadTokenStore: UploadTokenStore
  private let cacheURL: URL
  private let faviconCacheClearing: () -> Void

  public init(
    reducer: LockStateReducer = LockStateReducer(),
    clock: Clock = SystemClock(),
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    teamDirectoryStore: any TeamDirectoryStoring = TeamDirectoryStore(),
    tokenStore: HostTokenStore,
    uploadTokenStore: UploadTokenStore = UploadTokenStore(),
    cacheURL: URL,
    faviconCacheClearing: @escaping () -> Void = { FaviconLoader.shared?.clearCache() }
  ) {
    self.reducer = reducer
    self.clock = clock
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.teamDirectoryStore = teamDirectoryStore
    self.tokenStore = tokenStore
    self.uploadTokenStore = uploadTokenStore
    self.cacheURL = cacheURL
    self.faviconCacheClearing = faviconCacheClearing
  }

  /// Record user interaction — resets the idle timer. The next `tick()` reads
  /// the updated `lastActivityAt`; no state change is needed here.
  public func recordActivity() {
    lastActivityAt = clock.now
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

  /// Drop vault_key from memory (keeps bridge_key so biometric re-unlock is available);
  /// keeps cache + wrapped blobs. The AutoFill upload token is cleared (plan C6):
  /// a locked vault must not leave a spendable write token in the shared Keychain.
  public func lock() {
    stopTimer()
    try? uploadTokenStore.clear()
    state = .locked
  }

  /// Full sign-out: lock + delete tokens + clear cache + clear wrapped blobs.
  /// Ends in `.loggedOut` (not `.locked`) so the app routes to sign-in rather
  /// than the passphrase re-unlock screen (which has no token to re-unlock with).
  public func signOut(reason: LogoutReason = .manual) {
    try? bridgeKeyStore.delete()
    lock()
    try? tokenStore.deleteAll()
    try? wrappedKeyStore.clearAll()
    // Wipe the team-directory blob too (it lives outside WrappedKeyStore.clearAll).
    try? teamDirectoryStore.clear()
    let fm = FileManager.default
    if fm.fileExists(atPath: cacheURL.path) {
      try? fm.removeItem(at: cacheURL)
    }
    faviconCacheClearing()
    state = .loggedOut(reason: reason)
  }

  // MARK: - Private

  // internal (not private) so tests can drive the elapsed-lock path deterministically.
  func tick() {
    guard state == .unlocked else { return }
    let elapsed = clock.now.timeIntervalSince(lastActivityAt)
    if elapsed >= Double(_autoLockMinutes * 60) {
      switch timeoutAction {
      case .lock: lock()
      case .logout: signOut(reason: .idleTimeout)
      }
    }
  }
}
