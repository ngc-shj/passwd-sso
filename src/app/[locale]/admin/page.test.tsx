/**
 * The admin landing page picks the first console the user may see: tenant
 * admins go to the tenant console, team-only admins to their first team, and
 * everyone else back to the dashboard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockRedirect, mockSetRequestLocale, mockGetTenantRole, mockGetAdminTeamMemberships } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockRedirect: vi.fn(),
    mockSetRequestLocale: vi.fn(),
    mockGetTenantRole: vi.fn(),
    mockGetAdminTeamMemberships: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/i18n/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next-intl/server", () => ({ setRequestLocale: mockSetRequestLocale }));
vi.mock("@/lib/auth/access/tenant-auth", async () => {
  const { isTenantAdminRole } = await vi.importActual<
    typeof import("@/lib/constants/auth/tenant-role")
  >("@/lib/constants/auth/tenant-role");
  return { getTenantRole: mockGetTenantRole, isTenantAdminRole };
});
vi.mock("@/lib/auth/access/team-auth", () => ({
  getAdminTeamMemberships: mockGetAdminTeamMemberships,
}));

import AdminPage from "@/app/[locale]/admin/page";

function renderPage(locale = "ja") {
  return AdminPage({ params: Promise.resolve({ locale }) });
}

describe("AdminPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockGetTenantRole.mockResolvedValue("MEMBER");
    mockGetAdminTeamMemberships.mockResolvedValue([]);
  });

  it("sets the request locale from params", async () => {
    await expect(renderPage("ja")).rejects.toThrow("NEXT_REDIRECT");
    expect(mockSetRequestLocale).toHaveBeenCalledWith("ja");
  });

  it("redirects to sign-in without a session user", async () => {
    mockAuth.mockResolvedValue({ user: {} });

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith({ href: "/auth/signin", locale: "ja" });
    expect(mockGetTenantRole).not.toHaveBeenCalled();
  });

  it("redirects a tenant OWNER to the tenant members console", async () => {
    mockGetTenantRole.mockResolvedValue("OWNER");

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockGetTenantRole).toHaveBeenCalledWith("user-1");
    expect(mockRedirect).toHaveBeenCalledWith({ href: "/admin/tenant/members", locale: "ja" });
    expect(mockGetAdminTeamMemberships).not.toHaveBeenCalled();
  });

  it("redirects a tenant ADMIN to the tenant members console", async () => {
    mockGetTenantRole.mockResolvedValue("ADMIN");

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith({ href: "/admin/tenant/members", locale: "ja" });
  });

  it("redirects a team-only admin to the first admin team's general page", async () => {
    mockGetAdminTeamMemberships.mockResolvedValue([
      { team: { id: "team-a" } },
      { team: { id: "team-b" } },
    ]);

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockGetAdminTeamMemberships).toHaveBeenCalledWith("user-1");
    expect(mockRedirect).toHaveBeenCalledWith({ href: "/admin/teams/team-a/general", locale: "ja" });
  });

  it("redirects a user with no admin role anywhere to the dashboard", async () => {
    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith({ href: "/dashboard", locale: "ja" });
  });
});
