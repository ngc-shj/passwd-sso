import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockGetTenantMembership } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetTenantMembership: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => ({
  getTenantMembership: mockGetTenantMembership,
}));

import { GET } from "./route";

describe("GET /api/tenant/role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockGetTenantMembership.mockResolvedValue({
      id: "membership-1",
      tenantId: "tenant-1",
      userId: "test-user-id",
      role: "OWNER",
      deactivatedAt: null,
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns role for authenticated user with tenant membership", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.role).toBe("OWNER");
    expect(mockGetTenantMembership).toHaveBeenCalledWith("test-user-id");
  });

  it("returns null role when no tenant membership", async () => {
    mockGetTenantMembership.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.role).toBeNull();
  });

  it("returns ADMIN role for admin user", async () => {
    mockGetTenantMembership.mockResolvedValue({
      id: "membership-2",
      tenantId: "tenant-1",
      userId: "test-user-id",
      role: "ADMIN",
      deactivatedAt: null,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.role).toBe("ADMIN");
  });

  it("returns MEMBER role for regular member", async () => {
    mockGetTenantMembership.mockResolvedValue({
      id: "membership-3",
      tenantId: "tenant-1",
      userId: "test-user-id",
      role: "MEMBER",
      deactivatedAt: null,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.role).toBe("MEMBER");
  });
});
