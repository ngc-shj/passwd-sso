import { vi } from "vitest";

export interface MockMembership {
  id: string;
  orgId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
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
    role: "OWNER",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Creates mock implementations of all org-auth exports.
 * Use with: vi.mock("@/lib/org-auth", () => createOrgAuthMocks(...))
 */
export function createOrgAuthMocks(
  membership: MockMembership | null = createMockMembership()
) {
  // Keep the real OrgAuthError class for instanceof checks
  class OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "OrgAuthError";
      this.status = status;
    }
  }

  return {
    requireOrgMember: vi.fn(async () => {
      if (!membership) throw new OrgAuthError("NOT_FOUND", 404);
      return membership;
    }),
    requireOrgPermission: vi.fn(async () => {
      if (!membership) throw new OrgAuthError("NOT_FOUND", 404);
      return membership;
    }),
    hasOrgPermission: vi.fn(() => !!membership),
    getOrgMembership: vi.fn(async () => membership),
    isRoleAbove: vi.fn(() => true),
    OrgAuthError,
  };
}
