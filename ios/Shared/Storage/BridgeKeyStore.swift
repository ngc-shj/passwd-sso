import Foundation
import LocalAuthentication
import Security

// Per plan §"Encrypted-entries cache integrity":
// bridge_key_blob layout: [bridge_key:32][counter:8 BE][host_install_uuid:16] = 56 bytes total.
// All multi-byte integers are big-endian.

let bridgeKeyBlobSize = 56

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

  public struct Blob: Sendable, Equatable {
    public let bridgeKey: Data         // 32 bytes
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

  private let accessGroup: String
  private let service: String
  private let keychain: KeychainAccessor

  public init(
    accessGroup: String,
    service: String = "com.passwd-sso.bridge-key",
    keychain: KeychainAccessor = SystemKeychainAccessor()
  ) {
    self.accessGroup = accessGroup
    self.service = service
    self.keychain = keychain
  }

  /// Create on first unlock: random bridge_key, random non-zero counter, random UUID.
  public func create() throws -> Blob {
    var bridgeKeyBytes = Data(repeating: 0, count: 32)
    var counterBytes = Data(repeating: 0, count: 8)
    var uuidBytes = Data(repeating: 0, count: 16)

    let r1 = bridgeKeyBytes.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
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

    // Treat random bytes as a big-endian u64; ensure non-zero.
    // Per plan §"Encrypted-entries cache integrity": counter is big-endian in serialized form.
    var counter = counterBytes.withUnsafeBytes { UInt64(bigEndian: $0.load(as: UInt64.self)) }
    if counter == 0 { counter = 1 }

    let blob = Blob(
      bridgeKey: bridgeKeyBytes,
      cacheVersionCounter: counter,
      hostInstallUUID: uuidBytes
    )
    try persistBlob(blob)
    return blob
  }

  /// Read with biometric prompt (LAContext, reuseDuration = 0). Per plan S16.
  public func readForFill(reason: String) throws -> Blob {
    // Per plan T42: ONE Keychain read covers bridge_key + counter + uuid.
    let context = LAContext()
    // Per plan §"Per-fill biometric reuse": must be 0 to prevent iOS auth-cache reuse.
    context.touchIDAuthenticationAllowableReuseDuration = 0

    // Per plan S16: set localizedReason on LAContext before use.
    context.localizedReason = reason
    var query: [String: Any] = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecUseAuthenticationContext as String] = context

    let (status, data) = keychain.copyMatching(query: query)
    if status == errSecItemNotFound { throw Error.notFound }
    if status == errSecUserCanceled || status == errSecAuthFailed { throw Error.biometryFailed }
    guard status == errSecSuccess, let data else {
      throw Error.keychainError(status)
    }
    return try deserialize(data)
  }

  /// Increment counter and persist (called during cache write per plan §"Write ordering").
  public func incrementCounter(newCounter: UInt64) throws {
    var query: [String: Any] = baseQuery()
    query[kSecReturnData as String] = true

    let (status, existingData) = keychain.copyMatching(query: query)
    guard status == errSecSuccess, let existingData else {
      throw status == errSecItemNotFound ? Error.notFound : Error.keychainError(status)
    }
    var blob = try deserialize(existingData)
    blob = Blob(
      bridgeKey: blob.bridgeKey,
      cacheVersionCounter: newCounter,
      hostInstallUUID: blob.hostInstallUUID
    )
    let updateStatus = keychain.update(query: baseQuery(), attributes: [
      kSecValueData as String: serialize(blob),
    ])
    guard updateStatus == errSecSuccess else {
      throw Error.keychainError(updateStatus)
    }
  }

  /// Delete — no biometric required for delete (per plan §"App-side auto-lock or logout").
  public func delete() throws {
    let status = keychain.delete(query: baseQuery())
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw Error.keychainError(status)
    }
  }

  // MARK: - Private helpers

  private func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "blob",
      kSecAttrAccessGroup as String: accessGroup,
      kSecAttrSynchronizable as String: false,
    ]
  }

  private func persistBlob(_ blob: Blob) throws {
    var error: Unmanaged<CFError>?
    guard let accessControl = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      .biometryCurrentSet,  // Per plan S14: NO .devicePasscode fallback
      &error
    ) else {
      throw Error.keychainError(errSecParam)
    }

    var query = baseQuery()
    query[kSecValueData as String] = serialize(blob)
    query[kSecAttrAccessControl as String] = accessControl

    let status = keychain.add(query: query)
    if status == errSecDuplicateItem {
      let updateStatus = keychain.update(query: baseQuery(), attributes: [
        kSecValueData as String: serialize(blob),
        kSecAttrAccessControl as String: accessControl,
      ])
      guard updateStatus == errSecSuccess else { throw Error.keychainError(updateStatus) }
    } else if status != errSecSuccess {
      throw Error.keychainError(status)
    }
  }

  /// Serialize blob: [bridge_key:32][counter:8 BE][host_install_uuid:16] = 56 bytes.
  private func serialize(_ blob: Blob) -> Data {
    var data = Data(capacity: bridgeKeyBlobSize)
    data.append(blob.bridgeKey)
    let counterBE = blob.cacheVersionCounter.bigEndian
    withUnsafeBytes(of: counterBE) { data.append(contentsOf: $0) }
    data.append(blob.hostInstallUUID)
    return data
  }

  /// Deserialize from 56-byte blob.
  private func deserialize(_ data: Data) throws -> Blob {
    guard data.count == bridgeKeyBlobSize else { throw Error.invalidBlob }
    let bridgeKey = data[0..<32]
    // Per plan: big-endian u64 counter
    let counterBE = data[32..<40].withUnsafeBytes { $0.load(as: UInt64.self) }
    let counter = UInt64(bigEndian: counterBE)
    let uuid = data[40..<56]
    return Blob(
      bridgeKey: Data(bridgeKey),
      cacheVersionCounter: counter,
      hostInstallUUID: Data(uuid)
    )
  }
}
