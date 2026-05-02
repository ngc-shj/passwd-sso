import Foundation

/// Server URL TOFU pinning config (per plan §"Server URL TOFU").
public struct ServerConfig: Codable, Sendable, Equatable {
  public let baseURL: URL
  /// SHA-256 hash of the AASA file content, pinned on first sign-in.
  public let pinnedAASAHash: Data?
  /// SHA-256 hash of the server TLS SubjectPublicKeyInfo, pinned on first sign-in.
  public let pinnedTLSSPKIHash: Data?

  public init(baseURL: URL, pinnedAASAHash: Data? = nil, pinnedTLSSPKIHash: Data? = nil) {
    self.baseURL = baseURL
    self.pinnedAASAHash = pinnedAASAHash
    self.pinnedTLSSPKIHash = pinnedTLSSPKIHash
  }
}
