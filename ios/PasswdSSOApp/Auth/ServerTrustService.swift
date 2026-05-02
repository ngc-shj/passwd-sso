import CryptoKit
import Foundation
import Security
import Shared

// MARK: - Pin set

public struct PinSet: Sendable, Equatable, Codable {
  /// SHA-256 of the raw AASA file bytes.
  public let aasaSHA256: Data
  /// SHA-256 of the server leaf certificate SubjectPublicKeyInfo bytes.
  public let tlsSPKISHA256: Data

  public init(aasaSHA256: Data, tlsSPKISHA256: Data) {
    self.aasaSHA256 = aasaSHA256
    self.tlsSPKISHA256 = tlsSPKISHA256
  }
}

// MARK: - Validate result

public enum ValidateResult: Sendable, Equatable {
  /// Pinned and matches observed value — allow.
  case match
  /// No pin stored yet — caller should pin on first successful sign-in.
  case unpinned
  /// Stored pin differs from observed — surface "Trust new server?" to the user.
  case mismatch(stored: PinSet, observed: PinSet)
}

// MARK: - Service

/// TOFU pinning for the server's AASA file hash and TLS SPKI hash.
///
/// Pins are stored in the per-app Keychain under
/// `service = "com.passwd-sso.server-trust"`, `account = serverURL.absoluteString`.
public actor ServerTrustService {
  private let keychain: KeychainAccessor
  private let pinService = "com.passwd-sso.server-trust"

  public init(keychain: KeychainAccessor = SystemKeychainAccessor()) {
    self.keychain = keychain
  }

  // MARK: - Public API

  public func currentPin(for serverURL: URL) async throws -> PinSet? {
    let account = serverURL.absoluteString
    var query = baseQuery(account: account)
    query[kSecReturnData as String] = true

    let (status, data) = keychain.copyMatching(query: query)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data else {
      throw ServerTrustError.keychainError(status)
    }
    return try JSONDecoder().decode(PinSet.self, from: data)
  }

  public func pin(for serverURL: URL, _ pinSet: PinSet) async throws {
    let account = serverURL.absoluteString
    let data = try JSONEncoder().encode(pinSet)
    var query = baseQuery(account: account)
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

    let status = keychain.add(query: query)
    if status == errSecDuplicateItem {
      let updateStatus = keychain.update(
        query: baseQuery(account: account),
        attributes: [kSecValueData as String: data]
      )
      guard updateStatus == errSecSuccess else { throw ServerTrustError.keychainError(updateStatus) }
    } else if status != errSecSuccess {
      throw ServerTrustError.keychainError(status)
    }
  }

  public func validate(serverURL: URL, observed: PinSet) async -> ValidateResult {
    guard let stored = try? await currentPin(for: serverURL) else {
      return .unpinned
    }
    return stored == observed ? .match : .mismatch(stored: stored, observed: observed)
  }

  // MARK: - Helpers

  private func baseQuery(account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: pinService,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
    ]
  }
}

// MARK: - AASA hashing

/// Compute SHA-256 of the raw AASA file bytes.
public func hashAASA(_ data: Data) -> Data {
  let digest = SHA256.hash(data: data)
  return Data(digest)
}

// MARK: - TLS SPKI extraction

/// Delegate that captures the leaf-certificate SPKI SHA-256 during a TLS handshake.
///
/// Create the `URLSession` with this delegate and make a request to the server;
/// the delegate records the SPKI hash for subsequent TOFU pinning.
public final class SPKIPinningDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var _capturedSPKIHash: Data?

  public var capturedSPKIHash: Data? {
    lock.lock()
    defer { lock.unlock() }
    return _capturedSPKIHash
  }

  public func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let serverTrust = challenge.protectionSpace.serverTrust
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }

    // Default trust evaluation first.
    var error: CFError?
    let trusted = SecTrustEvaluateWithError(serverTrust, &error)
    guard trusted else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    // Extract leaf certificate SPKI hash.
    if let spkiHash = extractLeafSPKIHash(serverTrust: serverTrust) {
      lock.lock()
      _capturedSPKIHash = spkiHash
      lock.unlock()
    }

    completionHandler(.useCredential, URLCredential(trust: serverTrust))
  }

  private func extractLeafSPKIHash(serverTrust: SecTrust) -> Data? {
    // SecTrustCopyCertificateChain replaces SecTrustGetCertificateAtIndex (deprecated iOS 15).
    guard
      let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate],
      let leaf = chain.first,
      let publicKey = SecCertificateCopyKey(leaf),
      let keyData = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
    else {
      return nil
    }
    let digest = SHA256.hash(data: keyData)
    return Data(digest)
  }
}

// MARK: - Errors

public enum ServerTrustError: Error, Equatable {
  case keychainError(OSStatus)
}
