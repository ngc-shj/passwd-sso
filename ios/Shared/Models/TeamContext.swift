import Foundation

public enum TeamRole: String, Sendable, Codable {
  case admin
  case member
}

public struct TeamContext: Sendable, Equatable {
  public let teamId: String
  public let teamName: String
  public let role: TeamRole
  public let teamKeyVersion: Int

  public init(teamId: String, teamName: String, role: TeamRole, teamKeyVersion: Int) {
    self.teamId = teamId
    self.teamName = teamName
    self.role = role
    self.teamKeyVersion = teamKeyVersion
  }
}
