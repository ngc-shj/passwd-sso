import { vi } from "vitest";
import { TEAM_ROLE } from "@/lib/constants";
import type { TeamRoleValue } from "@/lib/constants";

export interface MockMembership {
  id: string;
  orgId: string;
  userId: string;
  role: TeamRoleValue;
  createdAt: Date;
  updatedAt: Date;
}

export function createMockMembership(
  overrides: Partial<MockMembership> = {}
): MockMembership {
  return {
    id: "member-1",
    orgId: "org-1",
    userId: "test-user-id",
    role: TEAM_ROLE.OWNER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Creates mock implementations of all org-auth exports.
 * Use with: vi.mock("@/lib/team-auth", () => createTeamAuthMocks(...))
 */
export function createTeamAuthMocks(
  membership: MockMembership | null = createMockMembership()
) {
  // Keep the real TeamAuthError class for instanceof checks
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }

  return {
    requireTeamMember: vi.fn(async () => {
      if (!membership) throw new TeamAuthError("NOT_FOUND", 404);
      return membership;
    }),
    requireTeamPermission: vi.fn(async () => {
      if (!membership) throw new TeamAuthError("NOT_FOUND", 404);
      return membership;
    }),
    hasTeamPermission: vi.fn(() => !!membership),
    getTeamMembership: vi.fn(async () => membership),
    isRoleAbove: vi.fn(() => true),
    TeamAuthError,
  };
}
