import CryptoKit
import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

// MARK: - Tests

final class RollbackFlagDrainTests: XCTestCase {

  private var tmpDir: URL!
  private var vaultKey: SymmetricKey!

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "RollbackFlagDrainTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    vaultKey = SymmetricKey(size: .bits256)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  private var flagURL: URL {
    tmpDir.appending(path: "rollback-flag.json", directoryHint: .notDirectory)
  }

  private func makePayload(kind: CacheRejectionKind = .counterMismatch) -> RollbackFlagPayload {
    RollbackFlagPayload(
      expectedCounter: 10,
      observedCounter: 99,
      headerIssuedAt: Date(timeIntervalSince1970: 1_700_000_000),
      rejectionKind: kind
    )
  }

  private func writeFlagFile(payload: RollbackFlagPayload, key: SymmetricKey) async throws {
    let writer = AppGroupRollbackFlagWriter(directory: tmpDir)
    try await writer.writeFlag(payload: payload, vaultKey: key)
  }

  // MARK: - drainPendingFlags_noFile_returns

  func testDrainPendingFlags_noFile_returns() async throws {
    // No flag file present.
    var postCalled = false
    MockURLProtocol.requestHandler = { _ in
      postCalled = true
      return (Data(), HTTPURLResponse(
        url: URL(string: "https://test.example/api/mobile/cache-rollback-report")!,
        statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }

    let (client, tokenStore) = makeDrainClient()
    seedDrainToken(tokenStore)
    let drain = RollbackFlagDrain(
      apiClient: client,
      flagDirectory: tmpDir,
      deviceId: { "device-001" }
    )

    await drain.drainPendingFlags(vaultKey: vaultKey)

    XCTAssertFalse(postCalled, "No POST should be made when no flag file exists")
    XCTAssertFalse(FileManager.default.fileExists(atPath: flagURL.path))
  }

  // MARK: - drainPendingFlags_validHMAC_postsToServer

  func testDrainPendingFlags_validHMAC_postsToServer() async throws {
    let payload = makePayload(kind: .counterMismatch)
    try await writeFlagFile(payload: payload, key: vaultKey)

    var capturedBody: CacheRollbackReportBody?
    let reportURL = URL(string: "https://test.example/api/mobile/cache-rollback-report")!
    MockURLProtocol.requestHandler = { request in
      if let data = request.httpBody ?? drainReadStream(request.httpBodyStream) {
        capturedBody = try? JSONDecoder().decode(CacheRollbackReportBody.self, from: data)
      }
      return (Data(), HTTPURLResponse(url: reportURL, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }

    let (client, tokenStore) = makeDrainClient()
    seedDrainToken(tokenStore)
    let drain = RollbackFlagDrain(
      apiClient: client,
      flagDirectory: tmpDir,
      deviceId: { "device-abc" }
    )

    await drain.drainPendingFlags(vaultKey: vaultKey)

    let body = try XCTUnwrap(capturedBody, "API POST body must be captured")
    XCTAssertEqual(body.deviceId, "device-abc")
    XCTAssertEqual(body.expectedCounter, payload.expectedCounter)
    XCTAssertEqual(body.observedCounter, payload.observedCounter)
    XCTAssertEqual(body.rejectionKind, CacheRejectionKind.counterMismatch.rawValue)
    XCTAssertFalse(FileManager.default.fileExists(atPath: flagURL.path), "Flag file must be deleted on 200")
  }

  // MARK: - drainPendingFlags_forgedHMAC_postsAsFlagForged

  func testDrainPendingFlags_forgedHMAC_postsAsFlagForged() async throws {
    // Write flag with one key but drain with a different key → HMAC mismatch.
    let payload = makePayload(kind: .counterMismatch)
    let writeKey = SymmetricKey(size: .bits256)
    try await writeFlagFile(payload: payload, key: writeKey)

    var capturedBody: CacheRollbackReportBody?
    let reportURL = URL(string: "https://test.example/api/mobile/cache-rollback-report")!
    MockURLProtocol.requestHandler = { request in
      if let data = request.httpBody ?? drainReadStream(request.httpBodyStream) {
        capturedBody = try? JSONDecoder().decode(CacheRollbackReportBody.self, from: data)
      }
      return (Data(), HTTPURLResponse(url: reportURL, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }

    let (client, tokenStore) = makeDrainClient()
    seedDrainToken(tokenStore)
    let drain = RollbackFlagDrain(
      apiClient: client,
      flagDirectory: tmpDir,
      deviceId: { "device-xyz" }
    )

    // Drain with a DIFFERENT vault key — HMAC will fail verification.
    let drainKey = SymmetricKey(size: .bits256)
    await drain.drainPendingFlags(vaultKey: drainKey)

    let body = try XCTUnwrap(capturedBody, "API POST must be made even for forged flags")
    XCTAssertEqual(body.rejectionKind, "flag_forged", "Forged flag must report as flag_forged")
    XCTAssertEqual(body.deviceId, "device-xyz")
    XCTAssertFalse(FileManager.default.fileExists(atPath: flagURL.path), "Flag file must be deleted on 200")
  }

  // MARK: - drainPendingFlags_serverError_keepsFlag

  func testDrainPendingFlags_serverError_keepsFlag() async throws {
    let payload = makePayload()
    try await writeFlagFile(payload: payload, key: vaultKey)

    let reportURL = URL(string: "https://test.example/api/mobile/cache-rollback-report")!
    MockURLProtocol.requestHandler = { _ in
      return (Data(), HTTPURLResponse(url: reportURL, statusCode: 500, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }

    let (client, tokenStore) = makeDrainClient()
    seedDrainToken(tokenStore)
    let drain = RollbackFlagDrain(
      apiClient: client,
      flagDirectory: tmpDir,
      deviceId: { "device-err" }
    )

    await drain.drainPendingFlags(vaultKey: vaultKey)

    XCTAssertTrue(FileManager.default.fileExists(atPath: flagURL.path),
                  "Flag file must be kept when server returns 500")
  }

  // MARK: - Helpers

  private func makeDrainClient() -> (MobileAPIClient, HostTokenStore) {
    let keychain = FakeKeychain()
    let tokenStore = HostTokenStore(service: "com.test.drain", keychain: keychain)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockURLProtocol.self]
    let session = URLSession(configuration: config)
    let client = MobileAPIClient(
      serverURL: URL(string: "https://test.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256", "x": "AAAAA", "y": "BBBBB"],
      tokenStore: tokenStore,
      urlSession: session
    )
    return (client, tokenStore)
  }

  private func seedDrainToken(_ store: HostTokenStore) {
    try? store.saveTokens(
      access: "acc_drain_test",
      refresh: "ref_drain_test",
      expiresAt: Date().addingTimeInterval(3600)
    )
  }
}

// MARK: - Stream reader helper (drain-test-local, distinct name avoids cross-file collision)

/// Read all bytes from an InputStream — distinct name to avoid ambiguity with
/// the same helper in MobileAPIClientTests.swift.
private func drainReadStream(_ stream: InputStream?) -> Data? {
  guard let stream else { return nil }
  stream.open()
  defer { stream.close() }
  var result = Data()
  let bufferSize = 1024
  let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
  defer { buffer.deallocate() }
  while stream.hasBytesAvailable {
    let read = stream.read(buffer, maxLength: bufferSize)
    if read <= 0 { break }
    result.append(buffer, count: read)
  }
  return result.isEmpty ? nil : result
}
