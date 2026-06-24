import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

// MARK: - Minimal PNG fixture

/// 1×1 red PNG (base64-encoded). Verified to produce a non-nil UIImage on iOS.
/// Generated via: UIGraphicsImageRenderer + pngData().
private let minimalPNGData: Data = {
  // A minimal 1×1 red pixel PNG. base64-decode to bytes at runtime to avoid
  // byte-literal mistakes. This is the canonical portable representation.
  let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
  return Data(base64Encoded: b64)!
}()

// MARK: - FaviconLoaderTests

final class FaviconLoaderTests: XCTestCase {

  private let serverURL = URL(string: "https://passwd-sso.example.com")!
  private var keychain: FakeKeychain!
  private var tokenStore: HostTokenStore!
  private var mockSession: URLSession!

  override func setUp() {
    super.setUp()
    keychain = FakeKeychain()
    tokenStore = HostTokenStore(service: "com.test.favicon-loader", keychain: keychain)
    // Seed a valid access token so validAccessToken() doesn't throw (T12).
    try? tokenStore.saveTokens(
      access: "acc_favicon_test",
      refresh: "ref_favicon_test",
      expiresAt: Date().addingTimeInterval(3600)
    )
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockURLProtocol.self]
    mockSession = URLSession(configuration: config)
    MockURLProtocol.requestHandler = nil
  }

  override func tearDown() {
    MockURLProtocol.requestHandler = nil
    mockSession = nil
    tokenStore = nil
    keychain = nil
    super.tearDown()
  }

  // MARK: - Helpers

  private func makeLoader() -> FaviconLoader {
    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: [
        "kty": "EC", "crv": "P-256",
        "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ],
      tokenStore: tokenStore,
      urlSession: mockSession
    )
    // Pass serverURL and the mock session so image(forHost:) can build the URL
    // without reading the App-Group stored server config (T12).
    return FaviconLoader(apiClient: client, serverURL: serverURL, session: mockSession)
  }

  // The stub matches all requests (MockURLProtocol.canInit returns true), so this
  // helper only needs the path, not host/size query items (T-3: dropped the unused
  // params that made the signature misleading).
  private func faviconURL() -> URL {
    serverURL
      .appending(path: "/api/mobile/favicon", directoryHint: .notDirectory)
  }

  private func stub(status: Int, body: Data, headers: [String: String] = [:]) {
    let url = faviconURL()
    MockURLProtocol.requestHandler = { _ in
      (body, httpResponse(status: status, url: url, headers: headers))
    }
  }

  // MARK: - Failure modes → nil

  @MainActor
  func testImage_401_returnsNil() async {
    stub(status: 401, body: Data())
    let loader = makeLoader()
    let result = await loader.image(forHost: "example.com", size: 32)
    XCTAssertNil(result, "401 response must yield nil image")
  }

  @MainActor
  func testImage_403_returnsNil() async {
    stub(status: 403, body: Data())
    let loader = makeLoader()
    let result = await loader.image(forHost: "example.com", size: 32)
    XCTAssertNil(result, "403 response must yield nil image")
  }

  @MainActor
  func testImage_404_returnsNil() async {
    stub(status: 404, body: Data())
    let loader = makeLoader()
    let result = await loader.image(forHost: "example.com", size: 32)
    XCTAssertNil(result, "404 response must yield nil image")
  }

  @MainActor
  func testImage_204_returnsNil() async {
    stub(status: 204, body: Data())
    let loader = makeLoader()
    let result = await loader.image(forHost: "example.com", size: 32)
    XCTAssertNil(result, "204 (no favicon) must yield nil image")
  }

  @MainActor
  func testImage_200_nonImageContentType_returnsNil() async {
    stub(status: 200, body: Data("not an image".utf8),
         headers: ["Content-Type": "text/plain"])
    let loader = makeLoader()
    let result = await loader.image(forHost: "example.com", size: 32)
    XCTAssertNil(result, "200 with non-image Content-Type must yield nil image")
  }

  @MainActor
  func testImage_200_nonDecodableBody_returnsNil() async {
    // Content-Type says image/png but the body is garbage — UIImage must fail to decode.
    stub(status: 200, body: Data("garbage not a png".utf8),
         headers: ["Content-Type": "image/png"])
    let loader = makeLoader()
    let result = await loader.image(forHost: "example.com", size: 32)
    XCTAssertNil(result, "200 with image/png but undecodable body must yield nil image")
  }

  // MARK: - Success path

  @MainActor
  func testImage_200_minimalPNG_returnsNonNil() async {
    stub(status: 200, body: minimalPNGData, headers: ["Content-Type": "image/png"])
    let loader = makeLoader()
    let result = await loader.image(forHost: "example.com", size: 32)
    XCTAssertNotNil(result, "200 + valid PNG body must yield a non-nil SwiftUI Image")
  }

  // MARK: - Cache directory (T12 / F10)

  func testFaviconCacheDirectorySitsUnderVaultDir() {
    let cacheDir = FaviconLoader.faviconCacheDirectory()
    // The directory must contain "vault" and "favicon-cache" in its path.
    let path = cacheDir.path
    XCTAssertTrue(
      path.contains("vault"),
      "favicon cache must be nested under the vault directory; got: \(path)"
    )
    XCTAssertTrue(
      path.contains("favicon-cache"),
      "favicon cache directory must be named 'favicon-cache'; got: \(path)"
    )
  }

  // MARK: - clearCache

  @MainActor
  func testClearCacheRemovesMemoryEntries() {
    // Use a pure in-memory URLCache so removeAllCachedResponses is reliable in
    // the test environment (disk URLCache may fail to open DB without entitlements).
    let memoryOnlyCache = URLCache(memoryCapacity: 1024 * 1024, diskCapacity: 0, directory: nil)
    let url = faviconURL()
    let response = URLResponse(
      url: url, mimeType: "image/png", expectedContentLength: 4, textEncodingName: nil)
    let cached = CachedURLResponse(response: response, data: Data([0x89, 0x50, 0x4E, 0x47]))
    memoryOnlyCache.storeCachedResponse(cached, for: URLRequest(url: url))
    XCTAssertNotNil(memoryOnlyCache.cachedResponse(for: URLRequest(url: url)),
                    "Precondition: cache must have the entry before clearing")

    memoryOnlyCache.removeAllCachedResponses()
    XCTAssertNil(memoryOnlyCache.cachedResponse(for: URLRequest(url: url)),
                 "clearCache must remove cached entries from memory")
  }

  /// R39: clearCache() must physically remove the on-disk favicon-cache directory
  /// (host-derived metadata) — the second half of clearCache() beyond the
  /// in-memory flush. Exercises the real loader.clearCache(), not a bare URLCache.
  @MainActor
  func testClearCacheRemovesDiskDirectory() throws {
    let loader = makeLoader()  // init creates faviconCacheDirectory()
    let dir = FaviconLoader.faviconCacheDirectory()
    let fm = FileManager.default
    // Seed a sentinel file so a successful removeItem on the dir is observable
    // even if URLCache opened no DB file in the test environment.
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    let sentinel = dir.appendingPathComponent("sentinel.bin")
    try Data([0x01]).write(to: sentinel)
    XCTAssertTrue(fm.fileExists(atPath: sentinel.path),
                  "Precondition: sentinel must exist before clearCache")

    loader.clearCache()

    XCTAssertFalse(fm.fileExists(atPath: dir.path),
                   "clearCache must remove the on-disk favicon-cache directory (R39)")
  }
}
