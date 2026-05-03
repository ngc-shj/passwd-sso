import CryptoKit
import Foundation
import Shared

/// Drains MAC-protected rollback flags written by the AutoFill extension.
///
/// On each host-app foreground, this actor reads the rollback-flag file from
/// the App Group container, verifies its HMAC, and POSTs the report to
/// `/api/mobile/cache-rollback-report`. On 200 the flag is deleted; on any
/// error the flag is kept and retried on the next foreground.
///
/// Forged flags (HMAC mismatch) are still reported to the server with
/// `rejectionKind: 'flag_forged'` so the server can rate-limit per device.
public actor RollbackFlagDrain {
  private let apiClient: MobileAPIClient
  private let flagDirectory: URL
  private let deviceId: @Sendable () -> String

  public init(
    apiClient: MobileAPIClient,
    flagDirectory: URL,
    deviceId: @Sendable @escaping () -> String
  ) {
    self.apiClient = apiClient
    self.flagDirectory = flagDirectory
    self.deviceId = deviceId
  }

  /// Reads the rollback flag file (if present), verifies HMAC, posts to the server,
  /// and deletes the flag on success.
  public func drainPendingFlags(vaultKey: SymmetricKey) async {
    let flagURL = flagDirectory.appending(path: "rollback-flag.json", directoryHint: .notDirectory)

    guard let fileData = try? Data(contentsOf: flagURL) else { return }

    let (body, rejectionKind) = buildReportBody(fileData: fileData, vaultKey: vaultKey)

    do {
      try await apiClient.postCacheRollbackReport(body)
      try? FileManager.default.removeItem(at: flagURL)
    } catch {
      // Keep the flag file for retry on next foreground.
      _ = rejectionKind
    }
  }

  // MARK: - Private

  /// Parse the flag file and build the POST body. On HMAC mismatch, override
  /// rejectionKind to 'flag_forged'. Returns (body, overridden rejectionKind).
  private func buildReportBody(
    fileData: Data,
    vaultKey: SymmetricKey
  ) -> (CacheRollbackReportBody, String) {
    // Attempt HMAC verification; on failure report flag_forged.
    if let verified = try? RollbackFlagVerifier.verify(fileData: fileData, vaultKey: vaultKey) {
      let payload = verified.payload
      let issuedAtISO: String? = payload.headerIssuedAt.map { isoString(from: $0) }
      let body = CacheRollbackReportBody(
        deviceId: deviceId(),
        expectedCounter: payload.expectedCounter,
        observedCounter: payload.observedCounter,
        headerIssuedAt: issuedAtISO,
        lastSuccessfulRefreshAt: nil,
        rejectionKind: payload.rejectionKind.rawValue
      )
      return (body, payload.rejectionKind.rawValue)
    }

    // Parse what we can from the JSON portion for the deviceId field.
    let body = buildForgedFlagBody(fileData: fileData)
    return (body, "flag_forged")
  }

  private func buildForgedFlagBody(fileData: Data) -> CacheRollbackReportBody {
    // Best-effort parse of the JSON line; on failure use zeroes.
    if let fileString = String(data: fileData, encoding: .utf8) {
      let lines = fileString.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
      if let payloadLine = lines.first,
         let payloadData = payloadLine.data(using: .utf8),
         let partial = try? JSONDecoder().decode(PartialFlagPayload.self, from: payloadData) {
        return CacheRollbackReportBody(
          deviceId: deviceId(),
          expectedCounter: partial.expectedCounter ?? 0,
          observedCounter: partial.observedCounter ?? 0,
          headerIssuedAt: nil,
          lastSuccessfulRefreshAt: nil,
          rejectionKind: "flag_forged"
        )
      }
    }
    return CacheRollbackReportBody(
      deviceId: deviceId(),
      expectedCounter: 0,
      observedCounter: 0,
      headerIssuedAt: nil,
      lastSuccessfulRefreshAt: nil,
      rejectionKind: "flag_forged"
    )
  }

  private func isoString(from date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}

// MARK: - Report body

public struct CacheRollbackReportBody: Sendable, Codable {
  public let deviceId: String
  public let expectedCounter: UInt64
  public let observedCounter: UInt64
  public let headerIssuedAt: String?
  public let lastSuccessfulRefreshAt: String?
  public let rejectionKind: String
}

// MARK: - Partial payload for forged-flag parsing

private struct PartialFlagPayload: Decodable {
  let expectedCounter: UInt64?
  let observedCounter: UInt64?
}
