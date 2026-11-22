/**
 * Team admin pages are reachable only by that team's OWNER/ADMIN; a MEMBER,
 * a non-member, or an anonymous request gets the 404 page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const { mockAuth, mockNotFound, mockGetTeamMembership } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockNotFound: vi.fn(),
  mockGetTeamMembership: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));
vi.mock("@/lib/auth/access/team-auth", async () => {
  const { isTeamAdminRole } = await vi.importActual<
    typeof import("@/lib/constants/team/team-role")
  >("@/lib/constants/team/team-role");
  return { getTeamMembership: mockGetTeamMembership, isTeamAdminRole };
});

import TeamAdminLayout from "@/app/[locale]/admin/teams/[teamId]/layout";

const child = <div data-testid="team-page" />;

async function renderLayout(): Promise<ReactElement> {
  return (await TeamAdminLayout({
    children: child,
    params: Promise.resolve({ teamId: "team-9" }),
  })) as ReactElement;
}

describe("TeamAdminLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 404 without a session user", async () => {
    mockAuth.mockResolvedValue({ user: {} });

    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetTeamMembership).not.toHaveBeenCalled();
  });

  it("returns 404 when the user is not a member of the team", async () => {
    mockGetTeamMembership.mockResolvedValue(null);

    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetTeamMembership).toHaveBeenCalledWith("user-1", "team-9");
  });

  it("returns 404 for a team MEMBER", async () => {
    mockGetTeamMembership.mockResolvedValue({ role: "MEMBER" });

    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the children for a team ADMIN", async () => {
    mockGetTeamMembership.mockResolvedValue({ role: "ADMIN" });

    const el = await renderLayout();
    expect((el.props as { children: ReactElement }).children).toBe(child);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("renders the children for a team OWNER", async () => {
    mockGetTeamMembership.mockResolvedValue({ role: "OWNER" });

    const el = await renderLayout();
    expect((el.props as { children: ReactElement }).children).toBe(child);
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
