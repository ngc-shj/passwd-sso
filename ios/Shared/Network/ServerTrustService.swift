import CryptoKit
import Foundation
import Security

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

/// Outcome of a non-mutating launch-time pin probe (`probePinnedIdentity`).
public enum PinProbeResult: Sendable, Equatable {
  /// Current TLS identity matches the stored pin.
  case match
  /// Delegate rejected the identity — genuine key rotation or MITM.
  case mismatch
  /// Could not reach the server (offline / DNS / timeout). Pin presumed intact.
  case unreachable
  /// No pin stored for this server.
  case pinMissing
}

// MARK: - Service

/// TOFU pinning for the server TLS leaf public key.
///
/// Pins are stored in the per-app Keychain under
/// `service = "com.passwd-sso.server-trust"`, `account = serverURL.absoluteString`.
public actor ServerTrustService {
  private let keychain: KeychainAccessor
  private let pinService = "com.passwd-sso.server-trust"

  /// Runs the health probe over a pinning session and returns the captured
  /// leaf-key hash (throwing `.pinMismatch` on a delegate-detected identity
  /// rejection). Injectable so the probe→outcome routing in
  /// `probePinnedIdentity`/`establishTrust`/`reestablishTrust` is testable
  /// without a live TLS server. Defaults to the real network probe.
  private let leafKeyProbe: @Sendable (URLSession, LeafKeyPinningDelegate, URL) async throws -> Data

  public init(keychain: KeychainAccessor = SystemKeychainAccessor()) {
    self.keychain = keychain
    self.leafKeyProbe = Self.networkLeafKeyProbe
  }

  /// Test seam: inject a probe that simulates the delegate/network outcome
  /// (a captured hash, `.pinMismatch`, or a connectivity `URLError`) without a
  /// real handshake. The default `init` wires the production network probe.
  init(
    keychain: KeychainAccessor,
    leafKeyProbe: @escaping @Sendable (URLSession, LeafKeyPinningDelegate, URL) async throws -> Data
  ) {
    self.keychain = keychain
    self.leafKeyProbe = leafKeyProbe
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
    // AfterFirstUnlock (NOT WhenUnlocked): the AutoFill extension reads the pin
    // mid-ceremony while the device may be in a locked-after-first-unlock state,
    // exactly as UploadTokenStore does for the paired upload token. A pin is a
    // public-key hash, not a secret, so the wider window carries no
    // confidentiality cost — and a WhenUnlocked pin would silently fail the
    // extension read and drop the upload the token was staged for.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = keychain.add(query: query)
    if status == errSecDuplicateItem {
      // Re-set kSecAttrAccessible on update so the attribute cannot drift
      // from a different writer pre-seeding the same item.
      let updateStatus = keychain.update(
        query: baseQuery(account: account),
        attributes: [
          kSecValueData as String: data,
          kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
      )
      guard updateStatus == errSecSuccess else { throw ServerTrustError.keychainError(updateStatus) }
    } else if status != errSecSuccess {
      throw ServerTrustError.keychainError(status)
    }
  }

  /// Remove the stored pin so the next `establishTrust` re-pins on first use.
  /// Fail-closed against silent MITM: this must only ever run behind an explicit
  /// user action (the "server identity changed — re-verify" affordance in server
  /// setup), never automatically on a mismatch. A legitimate server TLS-key
  /// rotation is otherwise a permanent lockout because `establishTrust` only
  /// pins when none is stored.
  ///
  /// `nonisolated`: touches only the Sendable `keychain` `let` and the
  /// `pinService` `let` (via `baseQuery`), no isolated mutable state — so the
  /// synchronous UI/test call sites need no `await`.
  public nonisolated func clearPin(for serverURL: URL) throws {
    let status = keychain.delete(query: baseQuery(account: serverURL.absoluteString))
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw ServerTrustError.keychainError(status)
    }
  }

  public func validate(serverURL: URL, observed: PinSet) async -> ValidateResult {
    guard let stored = try? await currentPin(for: serverURL) else {
      return .unpinned
    }
    return stored == observed ? .match : .mismatch(stored: stored, observed: observed)
  }

  /// Whether a pin is already stored for this server. Used to distinguish a
  /// first-time setup failure (plain unreachable) from a failure against an
  /// already-pinned server (possible TLS-key rotation → offer re-verification).
  public func currentPinExists(for serverURL: URL) async -> Bool {
    (try? await currentPin(for: serverURL)) != nil
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

    let observedTLS = try await probeLeafKey(session: session, delegate: delegate, healthURL: healthURL)

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

  /// Run the injected probe over `session` and return the captured leaf-key
  /// hash. The default (`networkLeafKeyProbe`) converts a delegate-detected
  /// identity rejection into an explicit `.pinMismatch` (rather than leaking the
  /// unspecified `URLError.Code` a cancelled challenge produces) so callers can
  /// route it deterministically.
  private func probeLeafKey(
    session: URLSession,
    delegate: LeafKeyPinningDelegate,
    healthURL: URL
  ) async throws -> Data {
    try await leafKeyProbe(session, delegate, healthURL)
  }

  /// Production network probe. Runs the health request over the pinning session
  /// and translates a delegate-detected identity rejection into `.pinMismatch`.
  private static let networkLeafKeyProbe:
    @Sendable (URLSession, LeafKeyPinningDelegate, URL) async throws -> Data = {
      session, delegate, healthURL in
      var request = URLRequest(url: healthURL)
      request.timeoutInterval = 10
      request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
      let data: Data
      let response: URLResponse
      do {
        (data, response) = try await session.data(for: request)
      } catch {
        // A cancelled TLS challenge surfaces as an unspecified URLError; the
        // delegate's flag is the authoritative mismatch signal. Kept as a pure
        // function so this exact translation is testable on the real
        // production path (not just behind an injected probe).
        throw mapProbeFailure(error, pinMismatchDetected: delegate.pinMismatchDetected)
      }
      guard isValidPasswdSSOHealthResponse(data: data, response: response) else {
        throw ServerTrustError.invalidHealthResponse
      }
      guard let observedTLS = delegate.capturedLeafKeyHash else {
        throw ServerTrustError.tlsKeyUnavailable
      }
      return observedTLS
    }

  /// Translate a probe transport failure into the caller-facing error. When the
  /// delegate flagged an identity rejection (leaf-key/host/default-trust
  /// mismatch), the underlying `URLError.Code` is unspecified, so surface the
  /// explicit `.pinMismatch`; otherwise the original connectivity error passes
  /// through. `nonisolated`/`static` so the mapping is unit-testable directly.
  nonisolated static func mapProbeFailure(_ error: Error, pinMismatchDetected: Bool) -> Error {
    pinMismatchDetected ? ServerTrustError.pinMismatch : error
  }

  /// Atomically replace the pin for a server whose TLS key legitimately rotated.
  /// Unlike a `clearPin` + `establishTrust` sequence, the OLD pin is kept until
  /// the new certificate has passed default trust evaluation AND the strict
  /// health contract — so a failed re-verification leaves the existing pin
  /// intact (no lockout, no unpinned window). The pin is overwritten only on
  /// full success.
  ///
  /// Fail-closed intent unchanged: this must run only behind an explicit user
  /// action (the "server identity changed — re-verify" affordance). It performs
  /// NO leaf-key match against the old pin — that is the whole point of a
  /// user-approved rotation — but it still runs `SecTrustEvaluateWithError`
  /// (platform CA trust) and the health contract before accepting the new key.
  public func reestablishTrust(serverURL: URL, healthURL: URL) async throws {
    // expectedLeafKeyHash: nil → capture the newly-presented key without
    // enforcing the old pin, but default trust evaluation + host binding still
    // apply inside the delegate.
    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: nil,
      expectedHost: serverURL.host
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }

    let observedTLS = try await probeLeafKey(session: session, delegate: delegate, healthURL: healthURL)

    // Overwrite only now, after full verification succeeded.
    try await pin(
      for: serverURL,
      PinSet(aasaSHA256: Data(), tlsLeafKeySHA256: observedTLS)
    )
  }

  /// Construct a URLSession that fails the TLS challenge unless the observed
  /// leaf public key matches the pin established during server setup. Throws
  /// `.pinMissing` when no pin is stored — callers with no way to establish one
  /// (e.g. the AutoFill extension, which must not run the network probe) treat
  /// that as fail-closed and skip the request.
  ///
  /// `cache` lets a caller (the favicon loader) attach an isolated on-disk
  /// URLCache without losing pinning — the previous favicon path built its own
  /// unpinned session precisely to get a separate cache.
  public func pinnedSession(for serverURL: URL, cache: URLCache? = nil) async throws -> URLSession {
    guard let stored = try await currentPin(for: serverURL) else {
      throw ServerTrustError.pinMissing
    }
    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: stored.tlsLeafKeySHA256,
      expectedHost: serverURL.host
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    if let cache {
      configuration.urlCache = cache
    }
    return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
  }

  /// Probe and verify the pinned identity before returning the session used by
  /// authenticated API calls. Calling establishTrust here also upgrades users
  /// who persisted a server URL before TLS pinning was wired into production.
  public func validatedSession(for serverURL: URL, healthURL: URL) async throws -> URLSession {
    try await establishTrust(serverURL: serverURL, healthURL: healthURL)
    return try await pinnedSession(for: serverURL)
  }

  /// Probe the stored pin against the server's current TLS identity WITHOUT
  /// modifying the pin. Used at launch to distinguish a genuine identity change
  /// (→ re-verify) from a transient outage (→ keep the cached vault usable),
  /// reading the delegate's authoritative mismatch flag rather than guessing
  /// from `URLError.Code`.
  public func probePinnedIdentity(for serverURL: URL, healthURL: URL) async -> PinProbeResult {
    guard let stored = try? await currentPin(for: serverURL) else {
      return .pinMissing
    }
    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: stored.tlsLeafKeySHA256,
      expectedHost: serverURL.host
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    do {
      _ = try await probeLeafKey(session: session, delegate: delegate, healthURL: healthURL)
      return .match
    } catch ServerTrustError.pinMismatch {
      return .mismatch
    } catch {
      // Connectivity failure or a non-mismatch trust error — the pin is
      // presumed intact; treat as unreachable so the cached vault stays usable.
      return .unreachable
    }
  }

  // MARK: - Helpers

  private nonisolated func baseQuery(account: String) -> [String: Any] {
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
///
/// Requires `status == "alive"` but does NOT pin the exact key count: the server
/// may add fields (version, build hash) to /api/health/live without locking out
/// clients on an older binary. The `status` marker still rejects generic pages.
func isValidPasswdSSOHealthResponse(data: Data, response: URLResponse) -> Bool {
  guard let http = response as? HTTPURLResponse,
    http.statusCode == 200,
    http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("application/json") == true,
    data.count <= 4_096,
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
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
  /// Set when the delegate cancels a challenge because the leaf key / host /
  /// default trust did not match — the AUTHORITATIVE mismatch signal. Callers
  /// read this after a request fails instead of guessing from `URLError.Code`
  /// (Apple does not contract which code a cancelled challenge produces).
  private var _pinMismatchDetected = false
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

  /// Whether the delegate rejected the server's TLS identity (leaf-key mismatch,
  /// host mismatch, or failed default trust) during the last handshake.
  public var pinMismatchDetected: Bool {
    lock.lock()
    defer { lock.unlock() }
    return _pinMismatchDetected
  }

  private func flagMismatch() {
    lock.lock()
    _pinMismatchDetected = true
    lock.unlock()
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
      flagMismatch()
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    // Default trust evaluation first.
    var error: CFError?
    let trusted = SecTrustEvaluateWithError(serverTrust, &error)
    guard trusted else {
      flagMismatch()
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    guard let hash = extractLeafKeyHash(serverTrust: serverTrust) else {
      // Key extraction failure is not an identity mismatch — leave the flag
      // unset so it surfaces as a generic trust/availability error.
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    if let expectedLeafKeyHash, hash != expectedLeafKeyHash {
      flagMismatch()
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
  /// The presented leaf key did not match the stored pin (or default CA trust /
  /// host binding failed) — a genuine identity change or MITM. Surfaced
  /// explicitly by the delegate so callers do not have to guess from an
  /// unspecified `URLError.Code`.
  case pinMismatch
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
    case .pinMismatch:
      return "The server's security identity does not match the one saved on this device."
    }
  }
}
