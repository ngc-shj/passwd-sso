import CryptoKit
import Foundation

// MARK: - Shared DPoP request helpers
//
// Single implementations shared by the host's MobileAPIClient and the
// extension's EntryUploader (which cannot use MobileAPIClient — that type is
// PasswdSSOApp-only and APPLICATION_EXTENSION_API_ONLY forbids moving it).

/// Strip query/fragment for the canonical htu value per RFC 9449 §4.2.
public func canonicalHTU(url: URL) -> String {
  var components = URLComponents(url: url, resolvingAgainstBaseURL: false) ?? URLComponents()
  components.query = nil
  components.fragment = nil
  return components.url?.absoluteString ?? url.absoluteString
}

/// SHA-256(token) → base64url, for the DPoP `ath` claim.
public func sha256Base64URL(_ token: String) -> String {
  let digest = SHA256.hash(data: Data(token.utf8))
  return base64URLEncode(Data(digest))
}

// MARK: - Entry create request (wire shape of POST /api/passwords)

public struct CreateEntryRequest: Sendable, Codable {
  public let id: String                 // client-generated UUIDv4 (REQUIRED for aadVersion >= 1)
  public let encryptedBlob: EncryptedData
  public let encryptedOverview: EncryptedData
  public let keyVersion: Int
  public let aadVersion: Int             // 1
  public let entryType: String           // "LOGIN" / "PASSKEY"

  public init(
    id: String,
    encryptedBlob: EncryptedData,
    encryptedOverview: EncryptedData,
    keyVersion: Int,
    aadVersion: Int,
    entryType: String
  ) {
    self.id = id
    self.encryptedBlob = encryptedBlob
    self.encryptedOverview = encryptedOverview
    self.keyVersion = keyVersion
    self.aadVersion = aadVersion
    self.entryType = entryType
  }
}

// MARK: - Errors

public enum EntryUploadError: Error, Equatable {
  /// Transport-level failure (offline, timeout). All upload errors cancel the
  /// registration; the distinction is diagnostic only.
  case network
  /// 401 after the single nonce-retry — token expired/revoked or DPoP rejected.
  case unauthorized
  case serverError(status: Int)
  /// 2xx without a decodable `{ id }` body.
  case invalidResponse
}

// MARK: - Uploader

/// Minimal create-only client for the AutoFill extension's synchronous passkey
/// upload (plan C4). Signs DPoP with the extension's shared-group SE key and
/// authenticates with the host-minted, jkt-bound upload token. Mirrors
/// MobileAPIClient.createEntry: `ath` = SHA-256(token), htm = POST, one retry
/// on 401 + fresh DPoP-Nonce. No refresh path — an expired token is a cancel,
/// never a lockout.
public struct EntryUploader: Sendable {
  private let serverURL: URL
  private let signer: any DPoPSigner
  private let jwk: [String: String]
  private let accessToken: String
  private let initialNonce: String?
  /// Persists each fresh DPoP-Nonce (e.g. back into UploadTokenStore) so later
  /// proofs start from the latest server value.
  private let onNonceUpdate: (@Sendable (String) -> Void)?
  private let urlSession: URLSession

  public init(
    serverURL: URL,
    signer: any DPoPSigner,
    jwk: [String: String],
    accessToken: String,
    initialNonce: String? = nil,
    onNonceUpdate: (@Sendable (String) -> Void)? = nil,
    urlSession: URLSession = .shared
  ) {
    self.serverURL = serverURL
    self.signer = signer
    self.jwk = jwk
    self.accessToken = accessToken
    self.initialNonce = initialNonce
    self.onNonceUpdate = onNonceUpdate
    self.urlSession = urlSession
  }

  /// POST /api/passwords. Returns the server-stored entry id on 200/201 —
  /// the caller (registration outcome gate) verifies it equals the
  /// client-generated id before completing the ceremony.
  public func createEntry(body: CreateEntryRequest) async throws -> String {
    let endpoint = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)
    let bodyData = try JSONEncoder().encode(body)

    var nonce = initialNonce
    var didNonceRetry = false
    while true {
      let proof = try await buildDPoPProof(
        htm: "POST", htu: htu, jwk: jwk, ath: ath, nonce: nonce, signer: signer
      )
      var request = URLRequest(url: endpoint)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue(proof.jws, forHTTPHeaderField: "DPoP")
      request.httpBody = bodyData

      let data: Data
      let response: URLResponse
      do {
        (data, response) = try await urlSession.data(for: request)
      } catch {
        throw EntryUploadError.network
      }
      guard let http = response as? HTTPURLResponse else {
        throw EntryUploadError.invalidResponse
      }

      // A nonce in THIS response is the actual challenge signal; persist it
      // for future proofs either way (RFC 9449 §8).
      let freshNonce = http.value(forHTTPHeaderField: "DPoP-Nonce")
      if let n = freshNonce {
        onNonceUpdate?(n)
        nonce = n
      }

      switch http.statusCode {
      case 200, 201:
        guard let resp = try? JSONDecoder().decode(CreateEntryResponse.self, from: data) else {
          throw EntryUploadError.invalidResponse
        }
        return resp.id
      case 401:
        if !didNonceRetry, freshNonce != nil {
          didNonceRetry = true
          continue
        }
        throw EntryUploadError.unauthorized
      default:
        throw EntryUploadError.serverError(status: http.statusCode)
      }
    }
  }
}

// MARK: - Private response types

private struct CreateEntryResponse: Decodable {
  let id: String
}
