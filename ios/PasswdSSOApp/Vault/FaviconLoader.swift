import Foundation
import Shared
import SwiftUI
import UIKit

// MARK: - FaviconLoader

/// Loads favicons via the server proxy and caches them in an isolated on-disk
/// URLCache under the App Group container. The caller's `session` is used for
/// the actual network request so the favicon cache stays separate from the
/// main API session's cache (F15).
///
/// `FaviconLoader.shared` starts as `nil`. The views batch wires it by calling
/// `FaviconLoader.configure(apiClient:)` once a signed-in `MobileAPIClient` is
/// available (after vault unlock). Tests instantiate `FaviconLoader(apiClient:session:)`
/// directly to inject a MockURLProtocol session without touching the singleton.
@MainActor
public final class FaviconLoader {

  // MARK: - Shared singleton

  /// App-wide singleton. `nil` until `configure(apiClient:)` is called (pre-unlock
  /// launch, or when no server config is present). Callers treat `nil` as
  /// "no favicon available" and fall back to the entry-type icon.
  nonisolated(unsafe) public private(set) static var shared: FaviconLoader?

  /// Wire the singleton after a successful vault unlock. Pass the server base URL
  /// so `image(forHost:size:)` can build favicon URLs without reading App-Group
  /// storage on every call. Safe to call multiple times (e.g. after a key rotation).
  ///
  /// The favicon session is the pinned one built by `apiClient` — favicon
  /// requests carry the same bearer/DPoP credentials as any API call and hit the
  /// app's own server, so they MUST be pinned. An unpinned session here would
  /// leak the access token to an on-path attacker who defeats TLS.
  public static func configure(apiClient: MobileAPIClient, serverURL: URL) {
    shared = FaviconLoader(apiClient: apiClient, serverURL: serverURL)
  }

  // MARK: - Internals

  let apiClient: MobileAPIClient
  let serverURL: URL?
  let urlCache: URLCache
  /// Injected session (tests). `nil` in production, where the pinned session is
  /// built lazily from `apiClient` on first fetch.
  private var cachedSession: URLSession?
  private let usesInjectedSession: Bool

  /// Production initializer. The pinned favicon session is built lazily from
  /// `apiClient` on first fetch (the pin is established during sign-in).
  /// `serverURL` overrides the App-Group stored server config.
  public init(apiClient: MobileAPIClient, serverURL: URL? = nil) {
    self.serverURL = serverURL
    self.apiClient = apiClient
    self.urlCache = Self.makeFaviconCache()
    self.cachedSession = nil
    self.usesInjectedSession = false
  }

  /// Test initializer. Inject a MockURLProtocol-backed session directly.
  public init(apiClient: MobileAPIClient, serverURL: URL? = nil, session: URLSession) {
    self.serverURL = serverURL
    self.apiClient = apiClient
    self.urlCache = Self.makeFaviconCache()
    self.cachedSession = session
    self.usesInjectedSession = true
  }

  private static func makeFaviconCache() -> URLCache {
    // Ensure the cache directory exists before building URLCache from it (F10).
    let cacheDir = Self.faviconCacheDirectory()
    try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    return URLCache(
      memoryCapacity: 4 * 1024 * 1024,   // 4 MB in-memory
      diskCapacity: 50 * 1024 * 1024,    // 50 MB on-disk
      directory: cacheDir
    )
  }

  /// The pinned favicon session, built once on first use. Returns `nil` when no
  /// pin is available (sign-in incomplete) — the caller treats that as "no
  /// favicon", never falling back to an unpinned session.
  private func session() async -> URLSession? {
    if let cachedSession { return cachedSession }
    guard !usesInjectedSession else { return nil }
    guard let built = await apiClient.makeFaviconSession(cache: urlCache) else { return nil }
    cachedSession = built
    return built
  }

  // MARK: - Public API

  /// Returns a SwiftUI `Image` for `host`, or `nil` when:
  /// - no server URL is configured
  /// - the host is empty/whitespace
  /// - the server returned 204 (no favicon) or a non-image body
  /// - the server returned 4xx/5xx
  /// - an auth or network error occurred (session dead / offline)
  ///
  /// Never throws. UIImage decoding is performed off the main actor.
  public func image(forHost host: String, size: Int) async -> Image? {
    guard let serverURL = serverURL ?? loadServerConfig()?.baseURL else { return nil }
    guard let url = FaviconProvider.iconURL(serverURL: serverURL, host: host, size: size) else {
      return nil
    }
    // No pinned session (sign-in incomplete) → no favicon. Never fall back to an
    // unpinned session: the request carries a live bearer token.
    guard let urlSession = await session() else { return nil }

    let result: (status: Int, contentType: String?, body: Data)
    do {
      result = try await apiClient.fetchFavicon(url: url, using: urlSession)
    } catch {
      // Auth dead, network error, etc. → no favicon.
      return nil
    }

    // Mirror the server's isAllowedFaviconMime intent: accept only raster image
    // types, never SVG (active content). Defense-in-depth — the server already
    // filters, but keep the client's acceptance window no wider than the server's.
    guard result.status == 200,
          let ct = result.contentType?.lowercased(),
          ct.hasPrefix("image/"), !ct.contains("svg")
    else { return nil }

    // Decode UIImage off the main actor to avoid blocking the main thread.
    let body = result.body
    return await Task.detached(priority: .userInitiated) {
      UIImage(data: body).map { Image(uiImage: $0) }
    }.value
  }

  /// Removes all cached favicons from memory and disk.
  public func clearCache() {
    urlCache.removeAllCachedResponses()
    try? FileManager.default.removeItem(at: Self.faviconCacheDirectory())
  }

  // MARK: - Cache directory

  /// `<AppGroup>/vault/favicon-cache/` — under the vault directory so it is
  /// cleared together with other vault-local data on sign-out.
  public nonisolated static func faviconCacheDirectory() -> URL {
    guard let containerURL = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: AppGroupContainer.identifier
    ) else {
      // Fallback for simulator/unit-test environments without the entitlement:
      // use a temp-dir subdirectory (cache data is non-critical).
      return FileManager.default.temporaryDirectory
        .appending(path: "passwd-sso-favicon-cache", directoryHint: .isDirectory)
    }
    return containerURL
      .appending(path: "vault", directoryHint: .isDirectory)
      .appending(path: "favicon-cache", directoryHint: .isDirectory)
  }
}
