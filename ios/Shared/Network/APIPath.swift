import Foundation

public enum APIPath {
  public static let mobileToken = "/api/mobile/token"
  public static let mobileTokenRefresh = "/api/mobile/token/refresh"
  public static let mobileAutofillToken = "/api/mobile/autofill-token"
  public static let mobileAuthorize = "/api/mobile/authorize"
  public static let mobileCacheRollbackReport = "/api/mobile/cache-rollback-report"
  public static let vaultUnlockData = "/api/vault/unlock/data"
  public static let passwords = "/api/passwords"
  public static let healthLive = "/api/health/live"
  public static let teams = "/api/teams"
  // Interpolated paths keep a builder so the {id}/{teamId} interpolation stays at the call site:
  public static func password(id: String) -> String { "\(passwords)/\(id)" }
  public static func teamPasswords(teamId: String) -> String { "\(teams)/\(teamId)/passwords" }
  public static func teamMemberKey(teamId: String) -> String { "\(teams)/\(teamId)/member-key" }
}
