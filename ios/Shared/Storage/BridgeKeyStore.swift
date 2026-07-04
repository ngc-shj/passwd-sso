import Foundation
import LocalAuthentication
import OSLog
import Security

// Storage layout: TWO Keychain items in the same App Group.
//   bridge-key-v2: 32-byte bridge_key, .biometryCurrentSet ACL
//   bridge-meta-v2: 24-byte (counter:8 BE || hostInstallUUID:16), no ACL
//
// Splitting the items lets host-app code read counter/uuid (via meta)
// without forcing a biometric prompt while AutoFill still gates bridge_key
// reads on biometrics.
//
// Legacy V1 storage (for migration only): ONE 56-byte combined item under
// `com.passwd-sso.bridge-key`. Read via the migration helper on first
// access after upgrade and replaced with the v2 layout.

// Internal (not public) so the test target can assert on sizes via
// `@testable import Shared` without leaking the values into the public
// Shared module surface.
internal let legacyBridgeKeyBlobSize = 56
internal let bridgeKeyV2Size = 32
internal let bridgeMetaV2Size = 24

/// Keychain abstraction for dependency injection in tests (per T42).
public protocol KeychainAccessor: Sendable {
  func add(query: [String: Any]) -> OSStatus
  func copyMatching(query: [String: Any]) -> (OSStatus, Data?)
  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus
  func delete(query: [String: Any]) -> OSStatus
}

/// Production Keychain implementation.
public struct SystemKeychainAccessor: KeychainAccessor, Sendable {
  public init() {}

  public func add(query: [String: Any]) -> OSStatus {
    SecItemAdd(query as CFDictionary, nil)
  }

  public func copyMatching(query: [String: Any]) -> (OSStatus, Data?) {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    return (status, result as? Data)
  }

  public func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
  }

  public func delete(query: [String: Any]) -> OSStatus {
    SecItemDelete(query as CFDictionary)
  }
}

public final class BridgeKeyStore: Sendable {

  // Diagnostic only — logs the raw OSStatus on a readForFill failure so the
  // AutoFill "vault locked" symptom can be traced to its true cause (item
  // missing vs. biometry failure vs. interaction-not-allowed/entitlement) via
  // Console.app. No key material is ever logged.
  private static let log = Logger(subsystem: AppGroupContainer.loggerSubsystem, category: "autofill")

  /// Logical bundle of bridge-key + counter/uuid. After the V2 split, the
  /// two Keychain items back this struct: `bridgeKey` comes from
  /// `bridge-key-v2` (biometric-gated), and `cacheVersionCounter` +
  /// `hostInstallUUID` come from `bridge-meta-v2` (no ACL).
  ///
  /// `readDirect()` returns a Blob with `bridgeKey` set to an empty
  /// `Data()` because that callers' code path never consumes the key.
  public struct Blob: Sendable, Equatable {
    public let bridgeKey: Data         // 32 bytes (or empty after readDirect)
    public let cacheVersionCounter: UInt64
    public let hostInstallUUID: Data   // 16 bytes

    public init(bridgeKey: Data, cacheVersionCounter: UInt64, hostInstallUUID: Data) {
      self.bridgeKey = bridgeKey
      self.cacheVersionCounter = cacheVersionCounter
      self.hostInstallUUID = hostInstallUUID
    }
  }

  public enum Error: Swift.Error, Equatable {
    case notFound
    case biometryFailed
    case invalidBlob
    case keychainError(OSStatus)
  }

  private let accessGroup: String?
  private let serviceKeyV2: String
  private let serviceMetaV2: String
  private let serviceLegacy: String
  private let keychain: KeychainAccessor
  /// Whether `readForFillAuthenticated` performs the real LAContext biometric
  /// evaluation. Production = true. Tests inject false so the unit suite (fake
  /// keychain, no real biometrics) exercises the read path without prompting.
  private let evaluatesBiometricExplicitly: Bool

  /// `service` is treated as the LEGACY service name (used for migration
  /// reads only). The two V2 service names are derived from it.
  ///
  /// Convention: `service` MUST end in "bridge-key". The v2 services are
  /// derived as `<service>-v2` (key) and the same string with "bridge-key"
  /// → "bridge-meta" plus "-v2" (meta). Tests follow the same convention.
  public init(
    accessGroup: String? = nil,
    service: String = "com.passwd-sso.bridge-key",
    keychain: KeychainAccessor = SystemKeychainAccessor(),
    evaluatesBiometricExplicitly: Bool = true
  ) {
    precondition(service.hasSuffix("bridge-key"),
                 "BridgeKeyStore service name must end in 'bridge-key'")
    self.accessGroup = accessGroup
    self.serviceLegacy = service
    self.serviceKeyV2 = service + "-v2"
    self.serviceMetaV2 = service
      .replacingOccurrences(of: "bridge-key", with: "bridge-meta") + "-v2"
    self.keychain = keychain
    self.evaluatesBiometricExplicitly = evaluatesBiometricExplicitly
  }

  // MARK: - Public API

  /// Create on first unlock: random bridge_key, random non-zero counter, random UUID.
  /// Writes BOTH v2 items in this order: meta first, then key. On failure
  /// of the second write, deletes the first to avoid orphaned state.
  public func create() throws -> Blob {
    var bridgeKeyBytes = Data(repeating: 0, count: bridgeKeyV2Size)
    var counterBytes = Data(repeating: 0, count: 8)
    var uuidBytes = Data(repeating: 0, count: 16)

    let r1 = bridgeKeyBytes.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, bridgeKeyV2Size, $0.baseAddress!)
    }
    let r2 = counterBytes.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, 8, $0.baseAddress!)
    }
    let r3 = uuidBytes.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!)
    }
    guard r1 == errSecSuccess, r2 == errSecSuccess, r3 == errSecSuccess else {
      throw Error.keychainError(errSecParam)
    }

    var counter = counterBytes.withUnsafeBytes { UInt64(bigEndian: $0.loadUnaligned(as: UInt64.self)) }
    if counter == 0 { counter = 1 }

    let blob = Blob(
      bridgeKey: bridgeKeyBytes,
      cacheVersionCounter: counter,
      hostInstallUUID: uuidBytes
    )

    try persistBlob(blob)
    // Best-effort cleanup: a legacy combined item is no longer needed.
    _ = keychain.delete(query: legacyBaseQuery())
    return blob
  }

  /// Read with biometric prompt. Sets `reuseDuration = 0` so each fill
  /// triggers a fresh biometric authentication instead of reusing iOS's
  /// auth cache. On legacy state, transparently migrate to v2 layout
  /// before returning.
  ///
  /// Relies on the keychain to implicitly trigger the biometric UI. This works
  /// in foreground (host app) and in the AutoFill *list* context, but NOT in the
  /// AutoFill "provide credential" context (passkey assertion / QuickType direct
  /// fill), where it returns errSecInteractionNotAllowed (-25308). Those callers
  /// must use `readForFillAuthenticated` instead.
  public func readForFill(reason: String) throws -> Blob {
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    context.localizedReason = reason
    return try readBlob(usingContext: context)
  }

  /// Like `readForFill`, but explicitly evaluates the biometric access control
  /// FIRST and reads the keychain with the resulting authenticated context.
  ///
  /// The AutoFill "provide credential" entry points (`prepareInterfaceToProvide-
  /// Credential` for a passkey assertion, and the passkey list) present no UI of
  /// their own before the read, so the keychain's implicit biometric prompt is
  /// disallowed (errSecInteractionNotAllowed / -25308). An explicit
  /// `evaluateAccessControl` CAN present the prompt in that context; the
  /// subsequent keychain read then reuses the authenticated context.
  public func readForFillAuthenticated(reason: String) async throws -> Blob {
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    context.localizedReason = reason

    if evaluatesBiometricExplicitly,
       let accessControl = SecAccessControlCreateWithFlags(
         kCFAllocatorDefault,
         kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
         .biometryCurrentSet,
         nil
       ) {
      do {
        try await context.evaluateAccessControl(
          accessControl, operation: .useItem, localizedReason: reason
        )
      } catch {
        Self.log.error("readForFillAuthenticated: evaluateAccessControl failed: \(String(describing: type(of: error)), privacy: .public)")
        throw Error.biometryFailed
      }
    }
    return try readBlob(usingContext: context)
  }

  /// Shared keychain read for both `readForFill` variants. `context` is whatever
  /// the caller prepared (implicitly- or explicitly-evaluated); it gates the
  /// biometric `bridge-key-v2` read and is reused for the legacy-migration read.
  private func readBlob(usingContext context: LAContext) throws -> Blob {
    // 1. Read bridge_key (biometric-gated).
    var keyQuery: [String: Any] = baseQuery(service: serviceKeyV2)
    keyQuery[kSecReturnData as String] = true
    keyQuery[kSecUseAuthenticationContext as String] = context
    let (keyStatus, keyData) = keychain.copyMatching(query: keyQuery)

    if keyStatus == errSecItemNotFound {
      // No v2 yet — try legacy migration with biometric.
      if let migrated = try tryMigrateLegacyBlob(context: context) {
        return migrated
      }
      Self.log.error("readForFill: bridge-key-v2 not found (status=\(keyStatus, privacy: .public)), no legacy item")
      throw Error.notFound
    }
    if keyStatus == errSecUserCanceled || keyStatus == errSecAuthFailed {
      Self.log.error("readForFill: biometry failed (status=\(keyStatus, privacy: .public))")
      throw Error.biometryFailed
    }
    guard keyStatus == errSecSuccess, let keyBytes = keyData else {
      Self.log.error("readForFill: keychain error (status=\(keyStatus, privacy: .public))")
      throw Error.keychainError(keyStatus)
    }
    guard keyBytes.count == bridgeKeyV2Size else { throw Error.invalidBlob }

    // 2. Read meta (no ACL — same context is harmless).
    let meta = try readMetaItem()
    return Blob(
      bridgeKey: keyBytes,
      cacheVersionCounter: meta.counter,
      hostInstallUUID: meta.uuid
    )
  }

  /// Read counter + uuid only — no biometric prompt. The returned Blob has
  /// `bridgeKey == Data()` (empty); callers that need the key must use
  /// `readForFill`.
  public func readDirect() throws -> Blob {
    do {
      let meta = try readMetaItem()
      return Blob(
        bridgeKey: Data(),
        cacheVersionCounter: meta.counter,
        hostInstallUUID: meta.uuid
      )
    } catch Error.notFound {
      // Try legacy migration without biometric.
      if let migrated = try tryMigrateLegacyBlob(context: nil) {
        return Blob(
          bridgeKey: Data(),
          cacheVersionCounter: migrated.cacheVersionCounter,
          hostInstallUUID: migrated.hostInstallUUID
        )
      }
      throw Error.notFound
    }
  }

  /// Increment counter and persist. Called by HostSyncService after the
  /// atomic cache-file rename so the on-disk file at counter N+1 is
  /// matched by the in-Keychain counter only after the file commit.
  public func incrementCounter(newCounter: UInt64) throws {
    // Read existing meta (or migrate from legacy if needed). The previous
    // counter is intentionally discarded — caller is the source of truth
    // for `newCounter`. We only need uuid to preserve the meta payload.
    let uuid: Data
    do {
      uuid = try readMetaItem().uuid
    } catch Error.notFound {
      if let migrated = try tryMigrateLegacyBlob(context: nil) {
        uuid = migrated.hostInstallUUID
      } else {
        throw Error.notFound
      }
    }

    let newMeta = serializeMeta(counter: newCounter, uuid: uuid)
    let updateStatus = keychain.update(
      query: baseQuery(service: serviceMetaV2),
      attributes: [kSecValueData as String: newMeta]
    )
    guard updateStatus == errSecSuccess else {
      throw Error.keychainError(updateStatus)
    }
  }

  /// Advance the meta counter to `observed` only if `observed == current + 1`.
  public func recoverForwardCounter(observed: UInt64) throws -> Bool {
    let current = try readDirect()
    guard observed == current.cacheVersionCounter + 1 else {
      return false
    }
    try incrementCounter(newCounter: observed)
    return true
  }

  /// Delete — no biometric required. Removes both v2 items and any
  /// remaining legacy item. Returns the first non-OK status (other than
  /// `errSecItemNotFound`) encountered, or success if everything was
  /// missing or deleted.
  public func delete() throws {
    var firstError: OSStatus = errSecSuccess
    for query in [
      baseQuery(service: serviceKeyV2),
      baseQuery(service: serviceMetaV2),
      legacyBaseQuery(),
    ] {
      let status = keychain.delete(query: query)
      if status != errSecSuccess && status != errSecItemNotFound && firstError == errSecSuccess {
        firstError = status
      }
    }
    guard firstError == errSecSuccess else {
      throw Error.keychainError(firstError)
    }
  }

  // MARK: - Private helpers — V2

  private func baseQuery(service: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "blob",
      kSecAttrSynchronizable as String: false,
    ]
    // Only pin an explicit access group when one is supplied. When nil, the
    // item lands in the app's DEFAULT keychain access group, which — given the
    // single `$(AppIdentifierPrefix)…shared` keychain-access-groups entitlement
    // — is exactly the app↔extension shared group. A literal team prefix cannot
    // be hardcoded (it is Apple-assigned and changes), and an App Group id is
    // NOT a valid keychain access group; both produce errSecMissingEntitlement
    // on device. Omitting the attribute is how HostTokenStore already works.
    if let accessGroup, !accessGroup.isEmpty {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    return query
  }

  private func legacyBaseQuery() -> [String: Any] {
    baseQuery(service: serviceLegacy)
  }

  private func readMetaItem() throws -> (counter: UInt64, uuid: Data) {
    var query: [String: Any] = baseQuery(service: serviceMetaV2)
    query[kSecReturnData as String] = true
    let (status, data) = keychain.copyMatching(query: query)
    if status == errSecItemNotFound { throw Error.notFound }
    guard status == errSecSuccess, let data else {
      throw Error.keychainError(status)
    }
    guard data.count == bridgeMetaV2Size else { throw Error.invalidBlob }
    let counter = data[0..<8].withUnsafeBytes { UInt64(bigEndian: $0.loadUnaligned(as: UInt64.self)) }
    let uuid = Data(data[8..<24])
    return (counter, uuid)
  }

  private func serializeMeta(counter: UInt64, uuid: Data) -> Data {
    var data = Data(capacity: bridgeMetaV2Size)
    let counterBE = counter.bigEndian
    withUnsafeBytes(of: counterBE) { data.append(contentsOf: $0) }
    data.append(uuid)
    return data
  }

  /// Persist BOTH v2 items. Order: meta first → key second. On failure
  /// of the key write, attempt to delete the meta to keep state self-
  /// consistent (next call will see notFound on both).
  private func persistBlob(_ blob: Blob) throws {
    let metaData = serializeMeta(counter: blob.cacheVersionCounter, uuid: blob.hostInstallUUID)

    // 1. Meta — no ACL.
    var metaQuery = baseQuery(service: serviceMetaV2)
    metaQuery[kSecValueData as String] = metaData
    metaQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

    var metaStatus = keychain.add(query: metaQuery)
    if metaStatus == errSecDuplicateItem {
      metaStatus = keychain.update(
        query: baseQuery(service: serviceMetaV2),
        attributes: [
          kSecValueData as String: metaData,
          kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
      )
    }
    guard metaStatus == errSecSuccess else {
      throw Error.keychainError(metaStatus)
    }

    // 2. Bridge key — .biometryCurrentSet ACL.
    var error: Unmanaged<CFError>?
    guard let accessControl = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      .biometryCurrentSet,
      &error
    ) else {
      // Roll back meta to keep partial-state out of the store.
      _ = keychain.delete(query: baseQuery(service: serviceMetaV2))
      throw Error.keychainError(errSecParam)
    }

    var keyQuery = baseQuery(service: serviceKeyV2)
    keyQuery[kSecValueData as String] = blob.bridgeKey
    keyQuery[kSecAttrAccessControl as String] = accessControl

    var keyStatus = keychain.add(query: keyQuery)
    if keyStatus == errSecDuplicateItem {
      keyStatus = keychain.update(
        query: baseQuery(service: serviceKeyV2),
        attributes: [
          kSecValueData as String: blob.bridgeKey,
          kSecAttrAccessControl as String: accessControl,
        ]
      )
    }
    if keyStatus != errSecSuccess {
      // Roll back meta on key-write failure.
      _ = keychain.delete(query: baseQuery(service: serviceMetaV2))
      throw Error.keychainError(keyStatus)
    }
  }

  // MARK: - Private helpers — legacy migration

  /// Read legacy 56-byte combined item; if present, persist as v2 and
  /// delete the legacy item. Returns the migrated Blob, or nil when
  /// no legacy item exists.
  ///
  /// `context` is used to authenticate the legacy item read when the
  /// caller is `readForFill`; pass nil from `readDirect`/`incrementCounter`
  /// (the legacy item had a `.biometryCurrentSet` ACL, so a no-context
  /// read either prompts via the system or fails — both cases are handled
  /// by treating the "miss" as `notFound`, in which case the caller
  /// surfaces the error and the user re-unlocks the vault).
  private func tryMigrateLegacyBlob(context: LAContext?) throws -> Blob? {
    var query: [String: Any] = legacyBaseQuery()
    query[kSecReturnData as String] = true
    if let context {
      query[kSecUseAuthenticationContext as String] = context
    }

    let (status, data) = keychain.copyMatching(query: query)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data else {
      // Treat any other failure as "no migration possible" — caller
      // surfaces notFound so the user re-creates fresh state.
      return nil
    }
    guard data.count == legacyBridgeKeyBlobSize else { return nil }

    let bridgeKey = Data(data[0..<32])
    let counter = data[32..<40]
      .withUnsafeBytes { UInt64(bigEndian: $0.loadUnaligned(as: UInt64.self)) }
    let uuid = Data(data[40..<56])
    let blob = Blob(
      bridgeKey: bridgeKey,
      cacheVersionCounter: counter,
      hostInstallUUID: uuid
    )

    // Write v2 items. On failure, leave legacy intact so the next call
    // re-attempts the migration.
    try persistBlob(blob)

    // Best-effort delete of legacy item; non-fatal if it fails.
    _ = keychain.delete(query: legacyBaseQuery())
    return blob
  }
}
