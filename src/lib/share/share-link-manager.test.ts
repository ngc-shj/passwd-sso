import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockRequireTeamPermission, mockWithTeamIpRestriction, TeamAuthError, PolicyViolationError } = vi.hoisted(() => {
  class TeamAuthError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  class PolicyViolationError extends Error {}
  return { mockRequireTeamPermission: vi.fn(), mockWithTeamIpRestriction: vi.fn(), TeamAuthError, PolicyViolationError };
});

vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/team/team-policy", () => ({
  withTeamIpRestriction: mockWithTeamIpRestriction,
  PolicyViolationError,
}));

import { SHARE_LINK_MANAGER, shareLinkManagerOf } from "./share-link-manager";

const req = new NextRequest("http://localhost/api/share-links/s1", { method: "DELETE" });
const teamShare = { createdById: "creator", teamPasswordEntry: { teamId: "team-1" } };

describe("shareLinkManagerOf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireTeamPermission.mockResolvedValue({ role: "ADMIN" });
    mockWithTeamIpRestriction.mockResolvedValue(undefined);
  });

  it("the creator of a team link manages it within the team's IP restriction, without a membership check", async () => {
    expect(await shareLinkManagerOf("creator", teamShare, req)).toBe(SHARE_LINK_MANAGER.CREATOR);
    expect(mockWithTeamIpRestriction).toHaveBeenCalledWith("team-1", req, "creator");
    expect(mockRequireTeamPermission).not.toHaveBeenCalled();
  });

  it("the creator of a team link outside the team's allowed network is refused", async () => {
    mockWithTeamIpRestriction.mockRejectedValue(new PolicyViolationError("blocked"));
    expect(await shareLinkManagerOf("creator", teamShare, req)).toBeNull();
  });

  it("the creator of a personal share or Send manages it with no team check", async () => {
    expect(await shareLinkManagerOf("creator", { createdById: "creator", teamPasswordEntry: null }, req)).toBe(
      SHARE_LINK_MANAGER.CREATOR,
    );
    expect(mockWithTeamIpRestriction).not.toHaveBeenCalled();
  });

  it("a team member holding PASSWORD_DELETE manages a team link, checked with the request (team IP restriction)", async () => {
    expect(await shareLinkManagerOf("admin", teamShare, req)).toBe(SHARE_LINK_MANAGER.TEAM_ADMIN);
    expect(mockRequireTeamPermission).toHaveBeenCalledWith("admin", "team-1", "password:delete", req);
  });

  it("a refused team check (no permission, not a member, IP blocked) is null", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    expect(await shareLinkManagerOf("member", teamShare, req)).toBeNull();
  });

  it("a personal share or Send is the creator's only", async () => {
    expect(await shareLinkManagerOf("admin", { createdById: "creator", teamPasswordEntry: null }, req)).toBeNull();
    expect(mockRequireTeamPermission).not.toHaveBeenCalled();
  });

  it("an unexpected error is not turned into a refusal", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("db down"));
    await expect(shareLinkManagerOf("admin", teamShare, req)).rejects.toThrow("db down");
  });
});
