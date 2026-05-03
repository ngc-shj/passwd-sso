import Foundation

public enum SessionState: Sendable {
  case signedOut
  case signedIn(userId: String, tenantId: String)
  case vaultLocked
  case vaultUnlocked
}
