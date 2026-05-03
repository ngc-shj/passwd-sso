import Foundation

public enum AppGroupContainerError: Error, Equatable {
  case containerNotFound
  case directoryCreationFailed
}

/// Centralises App Group container URL construction.
/// Both host app and AutoFill extension access the same group identifier.
public struct AppGroupContainer: Sendable {
  public static let identifier = "group.com.passwd-sso.shared"

  /// Returns the root URL of the shared App Group container.
  public static func url() throws -> URL {
    guard let containerURL = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: identifier
    ) else {
      throw AppGroupContainerError.containerNotFound
    }
    return containerURL
  }

  /// Returns `<container>/vault/encryptedEntries.cache`.
  public static func cacheFileURL() throws -> URL {
    let vaultDir = try url().appending(path: "vault", directoryHint: .isDirectory)
    return vaultDir.appending(path: "encryptedEntries.cache", directoryHint: .notDirectory)
  }

  /// Creates the `vault/` subdirectory if it does not exist.
  public static func ensureDirectoryExists() throws {
    let dir = try url().appending(path: "vault", directoryHint: .isDirectory)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      throw AppGroupContainerError.directoryCreationFailed
    }
  }
}
