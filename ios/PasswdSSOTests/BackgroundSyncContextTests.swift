import CryptoKit
import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

final class BackgroundSyncContextTests: XCTestCase {

  private func makeStubSyncService() -> HostSyncService {
    let client = MobileAPIClient(
      serverURL: URL(string: "https://test.example")!,
      signer: FakeSigner(),
      jwk: [:],
      tokenStore: HostTokenStore(service: "com.test.bgctx", keychain: FakeKeychain())
    )
    return HostSyncService(
      apiClient: client,
      entryFetcher: EntryFetcher(apiClient: client),
      bridgeKeyStore: BridgeKeyStore(
        accessGroup: "test.jp.jpng.passwd-sso.shared",
        service: "com.test.bgctx.bridge-key",
        keychain: FakeKeychain()
      ),
      wrappedKeyStore: TempDirWrappedKeyStore(baseDir: FileManager.default.temporaryDirectory),
      cacheURL: URL(fileURLWithPath: "/dev/null")
    )
  }

  func testReturnsNilBeforeUpdate() {
    let context = BackgroundSyncContext()

    XCTAssertNil(context.currentSyncService())
    XCTAssertNil(context.currentVaultKey())
    XCTAssertNil(context.currentUserId())
  }

  func testReturnsValuesAfterUpdate() {
    let context = BackgroundSyncContext()
    let key = SymmetricKey(size: .bits256)

    context.update(syncService: makeStubSyncService(), vaultKey: key, userId: "u-1")

    XCTAssertNotNil(context.currentSyncService())
    XCTAssertEqual(
      context.currentVaultKey()?.withUnsafeBytes { Data($0) },
      key.withUnsafeBytes { Data($0) }
    )
    XCTAssertEqual(context.currentUserId(), "u-1")
  }

  func testUpdateOverwritesPreviousValues() {
    let context = BackgroundSyncContext()
    context.update(
      syncService: makeStubSyncService(), vaultKey: SymmetricKey(size: .bits256), userId: "u-1"
    )

    let newKey = SymmetricKey(size: .bits256)
    context.update(syncService: makeStubSyncService(), vaultKey: newKey, userId: "u-2")

    XCTAssertEqual(context.currentUserId(), "u-2")
    XCTAssertEqual(
      context.currentVaultKey()?.withUnsafeBytes { Data($0) },
      newKey.withUnsafeBytes { Data($0) }
    )
  }
}
