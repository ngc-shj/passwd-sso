import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const { mockAuth, mockNotFound } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockNotFound: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));
vi.mock("@/lib/auth/access/team-auth", async () =>
  (await import("@/__tests__/helpers/mock-team-auth")).createTeamAuthMocks(),
);
vi.mock("@/components/watchtower/watchtower-page", () => ({ WatchtowerPage: () => null }));

import TeamWatchtowerPage from "./page";
import { WatchtowerPage } from "@/components/watchtower/watchtower-page";
import { requireTeamPermission, TeamAuthError } from "@/lib/auth/access/team-auth";
import { TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";

const mockRequireTeamPermission = vi.mocked(requireTeamPermission);

const MEMBERSHIP = {
  id: "member-1",
  teamId: "team-7",
  userId: "user-1",
  tenantId: "tenant-1",
  role: TEAM_ROLE.MEMBER,
  createdAt: new Date(),
  updatedAt: new Date(),
  keyDistributed: true,
  deactivatedAt: null,
  scimManaged: false,
  deactivatedByTenant: false,
  scimApprovalPending: false,
  admittedAt: null,
} satisfies Awaited<ReturnType<typeof requireTeamPermission>>;

function visit() {
  return TeamWatchtowerPage({ params: Promise.resolve({ teamId: "team-7" }) });
}

describe("TeamWatchtowerPage", () => {
  beforeEach(() => {
    mockNotFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(MEMBERSHIP);
  });

  it("renders the team-scoped watchtower with the caller's team role", async () => {
    const el = (await visit()) as ReactElement;
    expect(el.type).toBe(WatchtowerPage);
    expect(el.props).toEqual({ scope: { type: "team", teamId: "team-7" }, teamRole: TEAM_ROLE.MEMBER });
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("requires the password-update permission on the route's team", async () => {
    await visit();
    expect(mockRequireTeamPermission).toHaveBeenCalledWith(
      "user-1",
      "team-7",
      TEAM_PERMISSION.PASSWORD_UPDATE,
    );
  });

  it("returns notFound without a session", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(visit()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockRequireTeamPermission).not.toHaveBeenCalled();
  });

  it("returns notFound for a session without a user id", async () => {
    mockAuth.mockResolvedValue({ user: {} });
    await expect(visit()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockRequireTeamPermission).not.toHaveBeenCalled();
  });

  it("returns notFound when the caller lacks the team permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    await expect(visit()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it("rethrows an error that is not a team authorization failure", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("db down"));
    await expect(visit()).rejects.toThrow("db down");
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
