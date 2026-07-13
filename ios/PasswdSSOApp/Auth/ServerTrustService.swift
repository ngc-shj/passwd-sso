import CryptoKit
import Foundation
import Security
import Shared

// MARK: - Pin set

public struct PinSet: Sendable, Equatable, Codable {
  /// Legacy field retained for decoding pins written before the app switched
  /// to a custom callback scheme. New TLS-only pins store an empty value.
  public let aasaSHA256: Data

  /// SHA-256 of the leaf certificate's public key in
  /// `SecKeyCopyExternalRepresentation` form (uncompressed EC point or
  /// PKCS#1 RSAPublicKey, NOT SPKI DER). Stable per server identity but
  /// not interchangeable with `openssl dgst -sha256` over
  /// `-pubkey -outform DER`.
  public let tlsLeafKeySHA256: Data

  public init(aasaSHA256: Data, tlsLeafKeySHA256: Data) {
    self.aasaSHA256 = aasaSHA256
    self.tlsLeafKeySHA256 = tlsLeafKeySHA256
  }

  // Custom Codable to accept the legacy `tlsSPKISHA256` JSON key, kept
  // for forward-compat with older Keychain blobs. New writes encode only
  // the renamed key. Reads via `currentPin()` re-encode on the way out
  // so the legacy JSON gets upgraded after the first round-trip.
  private enum CodingKeys: String, CodingKey {
    case aasaSHA256
    case tlsLeafKeySHA256
    case tlsSPKISHA256  // legacy alias, decoder-only
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.aasaSHA256 = try c.decode(Data.self, forKey: .aasaSHA256)
    if let v = try c.decodeIfPresent(Data.self, forKey: .tlsLeafKeySHA256) {
      self.tlsLeafKeySHA256 = v
    } else {
      self.tlsLeafKeySHA256 = try c.decode(Data.self, forKey: .tlsSPKISHA256)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(aasaSHA256, forKey: .aasaSHA256)
    try c.encode(tlsLeafKeySHA256, forKey: .tlsLeafKeySHA256)
  }
}

// MARK: - Validate result

public enum ValidateResult: Sendable, Equatable {
  /// Pinned and matches observed value — allow.
  case match
  /// No pin stored yet — caller should establish trust through the health probe.
  case unpinned
  /// Stored pin differs from observed — fail closed; never silently replace it.
  case mismatch(stored: PinSet, observed: PinSet)
}

// MARK: - Service

/// TOFU pinning for the server TLS leaf public key.
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
    let pinSet = try JSONDecoder().decode(PinSet.self, from: data)
    // Migration-on-read: if the on-disk JSON used the legacy
    // `tlsSPKISHA256` key, re-encode and write back so subsequent reads
    // no longer hit the alias. Best-effort: a write failure is silently
    // ignored — the alias-decoder still works on the next call.
    if !looksLikeNewKey(data) {
      try? await pin(for: serverURL, pinSet)
    }
    return pinSet
  }

  /// Does the JSON already contain `"tlsLeafKeySHA256"`? If false, the
  /// blob was written by an older build that used the legacy alias key
  /// `tlsSPKISHA256`, and `currentPin()` re-encodes via `pin()` to upgrade.
  private func looksLikeNewKey(_ data: Data) -> Bool {
    data.range(of: Data("tlsLeafKeySHA256".utf8)) != nil
  }

  public func pin(for serverURL: URL, _ pinSet: PinSet) async throws {
    let account = serverURL.absoluteString
    let data = try JSONEncoder().encode(pinSet)
    var query = baseQuery(account: account)
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

    let status = keychain.add(query: query)
    if status == errSecDuplicateItem {
      // Re-set kSecAttrAccessible on update so the attribute cannot drift
      // from a different writer pre-seeding the same item.
      let updateStatus = keychain.update(
        query: baseQuery(account: account),
        attributes: [
          kSecValueData as String: data,
          kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
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

  /// Verify the configured server's health contract using normal platform TLS,
  /// then persist its leaf public-key hash on first use. Existing pins are
  /// enforced during the handshake and are never silently replaced.
  public func establishTrust(serverURL: URL, healthURL: URL) async throws {
    let stored = try await currentPin(for: serverURL)
    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: stored?.tlsLeafKeySHA256,
      expectedHost: serverURL.host
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }

    var request = URLRequest(url: healthURL)
    request.timeoutInterval = 10
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    let (data, response) = try await session.data(for: request)
    guard isValidPasswdSSOHealthResponse(data: data, response: response) else {
      throw ServerTrustError.invalidHealthResponse
    }
    guard let observedTLS = delegate.capturedLeafKeyHash else {
      throw ServerTrustError.tlsKeyUnavailable
    }

    if stored == nil {
      // aasaSHA256 is retained in the Codable shape for upgrades from earlier
      // builds. The app uses a custom callback scheme, so AASA is not a trust
      // input; an empty value marks the TLS-only pin format.
      try await pin(
        for: serverURL,
        PinSet(aasaSHA256: Data(), tlsLeafKeySHA256: observedTLS)
      )
    }
  }

  /// Construct a URLSession that fails the TLS challenge unless the observed
  /// leaf public key matches the pin established during server setup.
  public func pinnedSession(for serverURL: URL) async throws -> URLSession {
    guard let stored = try await currentPin(for: serverURL) else {
      throw ServerTrustError.pinMissing
    }
    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: stored.tlsLeafKeySHA256,
      expectedHost: serverURL.host
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
  }

  /// Probe and verify the pinned identity before returning the session used by
  /// authenticated API calls. Calling establishTrust here also upgrades users
  /// who persisted a server URL before TLS pinning was wired into production.
  public func validatedSession(for serverURL: URL, healthURL: URL) async throws -> URLSession {
    try await establishTrust(serverURL: serverURL, healthURL: healthURL)
    return try await pinnedSession(for: serverURL)
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

/// Strictly recognize the passwd-sso liveness response. A generic 2xx page,
/// redirect target, proxy login page, or similarly named service is rejected.
func isValidPasswdSSOHealthResponse(data: Data, response: URLResponse) -> Bool {
  guard let http = response as? HTTPURLResponse,
    http.statusCode == 200,
    http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("application/json") == true,
    data.count <= 4_096,
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    json.count == 1,
    json["status"] as? String == "alive"
  else { return false }
  return true
}

// MARK: - AASA hashing

/// Compute SHA-256 of the raw AASA file bytes.
public func hashAASA(_ data: Data) -> Data {
  let digest = SHA256.hash(data: data)
  return Data(digest)
}

// MARK: - TLS SPKI extraction

/// Delegate that captures the leaf-certificate public-key SHA-256 during
/// a TLS handshake.
///
/// Create the `URLSession` with this delegate and make a request to the
/// server; the delegate records the leaf-key hash for subsequent TOFU
/// pinning. NOTE: the captured value is `SHA256(SecKeyCopyExternalRepresentation
/// output)`, NOT `SHA256(SubjectPublicKeyInfo DER)`. Stable per server
/// identity, but not interchangeable with values produced by `openssl`.
public final class LeafKeyPinningDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var _capturedLeafKeyHash: Data?
  private let expectedLeafKeyHash: Data?
  private let expectedHost: String?

  public init(expectedLeafKeyHash: Data? = nil, expectedHost: String? = nil) {
    self.expectedLeafKeyHash = expectedLeafKeyHash
    self.expectedHost = expectedHost?.lowercased()
  }

  public var capturedLeafKeyHash: Data? {
    lock.lock()
    defer { lock.unlock() }
    return _capturedLeafKeyHash
  }

  public func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let serverTrust = challenge.protectionSpace.serverTrust
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    guard expectedHost == nil || challenge.protectionSpace.host.lowercased() == expectedHost else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    // Default trust evaluation first.
    var error: CFError?
    let trusted = SecTrustEvaluateWithError(serverTrust, &error)
    guard trusted else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    guard let hash = extractLeafKeyHash(serverTrust: serverTrust) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    if let expectedLeafKeyHash, hash != expectedLeafKeyHash {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    lock.lock()
    _capturedLeafKeyHash = hash
    lock.unlock()

    completionHandler(.useCredential, URLCredential(trust: serverTrust))
  }

  public func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard let url = request.url,
      url.scheme?.lowercased() == "https",
      expectedHost == nil || url.host?.lowercased() == expectedHost
    else {
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }

  private func extractLeafKeyHash(serverTrust: SecTrust) -> Data? {
    // SecTrustCopyCertificateChain replaces SecTrustGetCertificateAtIndex (deprecated iOS 15).
    // Hash is over `SecKeyCopyExternalRepresentation` output:
    //   - ECDSA P-256: 65-byte uncompressed point (0x04 || X || Y)
    //   - RSA: PKCS#1 RSAPublicKey DER
    // NOT SubjectPublicKeyInfo DER.
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
  case pinMissing
  case tlsKeyUnavailable
  case invalidHealthResponse
}

extension ServerTrustError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .keychainError:
      return "Could not securely store the server identity."
    case .pinMissing:
      return "The server identity has not been verified. Set up the server again."
    case .tlsKeyUnavailable:
      return "Could not verify the server TLS identity."
    case .invalidHealthResponse:
      return "The server did not return a valid passwd-sso health response."
    }
  }
}
