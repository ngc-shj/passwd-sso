/**
 * The tenant admin console is reachable only by tenant OWNER/ADMIN; everyone
 * else gets the 404 page, not a redirect that would reveal the console exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const { mockAuth, mockNotFound, mockGetTenantRole } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockNotFound: vi.fn(),
  mockGetTenantRole: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));
vi.mock("@/lib/auth/access/tenant-auth", async () => {
  const { isTenantAdminRole } = await vi.importActual<
    typeof import("@/lib/constants/auth/tenant-role")
  >("@/lib/constants/auth/tenant-role");
  return { getTenantRole: mockGetTenantRole, isTenantAdminRole };
});

import TenantAdminLayout from "@/app/[locale]/admin/tenant/layout";

const child = <div data-testid="tenant-page" />;

async function renderLayout(): Promise<ReactElement> {
  return (await TenantAdminLayout({ children: child })) as ReactElement;
}

describe("TenantAdminLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 404 without a session user", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetTenantRole).not.toHaveBeenCalled();
  });

  it("returns 404 for a tenant MEMBER", async () => {
    mockGetTenantRole.mockResolvedValue("MEMBER");

    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetTenantRole).toHaveBeenCalledWith("user-1");
  });

  it("returns 404 for a user with no tenant role", async () => {
    mockGetTenantRole.mockResolvedValue(null);

    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the children for a tenant ADMIN", async () => {
    mockGetTenantRole.mockResolvedValue("ADMIN");

    const el = await renderLayout();
    expect((el.props as { children: ReactElement }).children).toBe(child);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("renders the children for a tenant OWNER", async () => {
    mockGetTenantRole.mockResolvedValue("OWNER");

    const el = await renderLayout();
    expect((el.props as { children: ReactElement }).children).toBe(child);
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
