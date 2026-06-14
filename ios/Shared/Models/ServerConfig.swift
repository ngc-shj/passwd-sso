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

// MARK: - App Group persistence

/// UserDefaults key for the JSON-encoded ServerConfig in the App Group suite.
/// Shared so the host (writes at setup) and the AutoFill extension (reads for
/// the passkey-registration upload) agree on one location.
public let serverConfigDefaultsKey = "serverConfig"

public func saveServerConfig(_ config: ServerConfig, defaults: UserDefaults) {
  guard let data = try? JSONEncoder().encode(config) else { return }
  defaults.set(data, forKey: serverConfigDefaultsKey)
}

public func loadServerConfig(
  defaults: UserDefaults? = UserDefaults(suiteName: AppGroupContainer.identifier)
) -> ServerConfig? {
  guard let data = defaults?.data(forKey: serverConfigDefaultsKey) else { return nil }
  return try? JSONDecoder().decode(ServerConfig.self, from: data)
}
