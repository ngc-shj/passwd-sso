import CryptoKit
import Foundation

// MARK: - Public types

/// Payload written to the rollback-flag file by the AutoFill extension on cache rejection.
/// The host-app drain (Step 11) reads this, verifies HMAC, and posts to the server.
public struct RollbackFlagPayload: Sendable, Codable, Equatable {
  public let expectedCounter: UInt64
  public let observedCounter: UInt64
  public let headerIssuedAt: Date?
  public let rejectionKind: CacheRejectionKind

  public init(
    expectedCounter: UInt64,
    observedCounter: UInt64,
    headerIssuedAt: Date?,
    rejectionKind: CacheRejectionKind
  ) {
    self.expectedCounter = expectedCounter
    self.observedCounter = observedCounter
    self.headerIssuedAt = headerIssuedAt
    self.rejectionKind = rejectionKind
  }
}

/// Writes a MAC-protected rollback flag to App Group.
/// Step 11 wires the actual server post; Step 8-9 only ensures the flag is written.
public protocol RollbackFlagWriter: Sendable {
  func writeFlag(payload: RollbackFlagPayload, vaultKey: SymmetricKey) async throws
}

// MARK: - App Group implementation

public struct AppGroupRollbackFlagWriter: RollbackFlagWriter, Sendable {
  private let directory: URL

  public init(directory: URL) {
    self.directory = directory
  }

  public func writeFlag(payload: RollbackFlagPayload, vaultKey: SymmetricKey) async throws {
    let flagURL = directory.appending(path: "rollback-flag.json", directoryHint: .notDirectory)
    let tmpURL = directory.appending(
      path: "rollback-flag.json.tmp",
      directoryHint: .notDirectory
    )

    let macKey = deriveMacKey(from: vaultKey)
    let payloadJSON = try encodePayloadCanonically(payload)
    let mac = computeHMAC(key: macKey, data: payloadJSON)
    let macBase64 = mac.base64URLEncoded()

    guard let payloadString = String(data: payloadJSON, encoding: .utf8) else {
      throw RollbackFlagError.encodingFailed
    }
    let fileContents = "\(payloadString)\n\(macBase64)"
    guard let fileData = fileContents.data(using: .utf8) else {
      throw RollbackFlagError.encodingFailed
    }

    try ensureDirectory()
    try fileData.write(to: tmpURL, options: .atomic)
    _ = try FileManager.default.replaceItemAt(flagURL, withItemAt: tmpURL)
  }

  // MARK: - Private helpers

  private func ensureDirectory() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  private func encodePayloadCanonically(_ payload: RollbackFlagPayload) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    encoder.dateEncodingStrategy = .secondsSince1970
    return try encoder.encode(payload)
  }

  private func deriveMacKey(from vaultKey: SymmetricKey) -> SymmetricKey {
    let info = "rollback-flag-mac".data(using: .utf8)!
    let salt = Data(repeating: 0, count: 32)
    return HKDF<SHA256>.deriveKey(
      inputKeyMaterial: vaultKey,
      salt: salt,
      info: info,
      outputByteCount: 32
    )
  }

  private func computeHMAC(key: SymmetricKey, data: Data) -> Data {
    var h = HMAC<SHA256>(key: key)
    h.update(data: data)
    return Data(h.finalize())
  }
}

// MARK: - HMAC verifier (used by host-app drain and tests)

/// Verifies a rollback-flag file written by AppGroupRollbackFlagWriter.
public enum RollbackFlagVerifier {
  public struct VerifiedFlag: Sendable, Equatable {
    public let payload: RollbackFlagPayload
  }

  public static func verify(fileData: Data, vaultKey: SymmetricKey) throws -> VerifiedFlag {
    guard let fileString = String(data: fileData, encoding: .utf8) else {
      throw RollbackFlagError.malformedFile
    }
    let lines = fileString.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard lines.count >= 2 else {
      throw RollbackFlagError.malformedFile
    }
    let payloadLine = lines[0]
    let macLine = lines[1]

    guard let payloadData = payloadLine.data(using: .utf8) else {
      throw RollbackFlagError.malformedFile
    }
    guard let expectedMACData = Data(base64URLEncoded: macLine) else {
      throw RollbackFlagError.macMismatch
    }

    let macKey = deriveMacKey(from: vaultKey)
    var h = HMAC<SHA256>(key: macKey)
    h.update(data: payloadData)
    let actualMAC = Data(h.finalize())

    guard actualMAC == expectedMACData else {
      throw RollbackFlagError.macMismatch
    }

    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .secondsSince1970
    let payload = try decoder.decode(RollbackFlagPayload.self, from: payloadData)
    return VerifiedFlag(payload: payload)
  }

  private static func deriveMacKey(from vaultKey: SymmetricKey) -> SymmetricKey {
    let info = "rollback-flag-mac".data(using: .utf8)!
    let salt = Data(repeating: 0, count: 32)
    return HKDF<SHA256>.deriveKey(
      inputKeyMaterial: vaultKey,
      salt: salt,
      info: info,
      outputByteCount: 32
    )
  }
}

public enum RollbackFlagError: Error, Equatable {
  case encodingFailed
  case malformedFile
  case macMismatch
}

// MARK: - Data base64url helpers

private extension Data {
  func base64URLEncoded() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  init?(base64URLEncoded string: String) {
    var s = string
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    self.init(base64Encoded: s)
  }
}
